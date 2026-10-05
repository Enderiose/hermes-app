"""验证：会话激活期内，增量工具调用是否直接并进「同轮次工具调用」整合行。

不依赖真实 run：直接驱动页面里 connectSocket() 注册的真实 socket handler
（run.started / tool.started / tool.completed / resumed），断言 DOM。
"""
import json
import os

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-toolgroup'
os.makedirs(OUT, exist_ok=True)

HTML = open(INLINE, encoding='utf-8').read()
fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' | ' + str(detail) if detail else ''))
    if not cond:
        fails.append(name)


FIRE = """([ev, payload]) => window.__fire(ev, payload)"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');"
        "localStorage.setItem('hm_user', 'tooltest');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        "window.__fire = function (ev, payload) {"
        "  const s = state;"
        "  if (!s || !s.socket) return -1;"
        "  const hs = typeof s.socket.listeners === 'function'"
        "    ? s.socket.listeners(ev)"
        "    : ((s.socket._callbacks && s.socket._callbacks['$' + ev]) || []).map(f => f.fn || f);"
        "  hs.forEach(h => h(payload));"
        "  return hs.length;"
        "};"
        % (json.dumps(BASE), json.dumps(TOKEN))
    )
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    logs = []
    page.on('pageerror', lambda e: logs.append('PAGEERROR: %s' % e))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4500)

    check('页面暴露 state', page.evaluate('typeof state') == 'object', page.evaluate('typeof state'))
    rows = page.locator('#session-list .row')
    rows.first.click()
    page.wait_for_timeout(4000)
    check('已进入聊天视图', page.locator('#view-chat').is_visible())

    sid = page.evaluate('state.cur')
    print('会话:', sid[:24] if sid else sid)
    check('socket 已连接', bool(page.evaluate('!!(state.socket && state.socket.connected)')))

    # ---- 场景 A：从零开始的运行（本客户端发起） ----
    n = page.evaluate("""() => {
        state.msgs = state.msgs.filter(m => m.role !== 'tool');   // 隔离历史工具行
        state.activeRunId = ''; state.lastHistoryRun = '';
        const sid = state.cur;
        __fire('run.started', { event: 'run.started', session_id: sid, run_id: 'TESTRUN_A' });
        __fire('tool.started', { event: 'tool.started', session_id: sid, run_id: 'TESTRUN_A',
                               tool: 'terminal', tool_call_id: 'c1', preview: 'pwd' });
        __fire('tool.started', { event: 'tool.started', session_id: sid, run_id: 'TESTRUN_A',
                               tool: 'read_file', tool_call_id: 'c2', preview: 'app.js' });
        return state.msgs.filter(m => m.role === 'tool').length;
    }""")
    check('run.started 认下 activeRunId', page.evaluate("state.activeRunId") == 'TESTRUN_A',
          page.evaluate("state.activeRunId"))
    check('两次 tool.started = 两条工具行（未重复）', n == 2, n)

    dom1 = page.evaluate("""() => {
        const g = document.querySelectorAll('#msg-list .tool-run-row');
        return { groups: g.length,
                 count: g.length ? g[0].querySelector('.tool-run-count').textContent : '',
                 running: document.querySelectorAll('#msg-list .tool-run-running').length,
                 loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length };
    }""")
    check('新工具条目已并进整合行（1 组）', dom1['groups'] == 1, dom1)
    check('整合行计数 = 2', dom1['count'].startswith('2 '), dom1['count'])
    check('整合行显示运行中', dom1['running'] == 1, dom1)
    check('没有散落的单条工具行', dom1['loose'] == 0, dom1)
    page.screenshot(path=OUT + '/01-live-group-running.png')

    # ---- 场景 B：completed 就地更新（不新增行） ----
    done = page.evaluate(FIRE, ['tool.completed', {'event': 'tool.completed', 'session_id': sid,
                                                   'run_id': 'TESTRUN_A', 'tool': 'terminal',
                                                   'tool_call_id': 'c1', 'output': 'ok'}])
    dom2 = page.evaluate("""() => {
        const g = document.querySelectorAll('#msg-list .tool-run-row');
        return { groups: g.length,
                 count: g[0] ? g[0].querySelector('.tool-run-count').textContent : '',
                 running: document.querySelectorAll('#msg-list .tool-run-running').length,
                 toolMsgs: state.msgs.filter(m => m.role === 'tool').length,
                 c1: (state.msgs.find(m => m.toolCallId === 'c1') || {}).status };
    }""")
    check('completed 后仍是 1 组 2 条（不新增行）',
          dom2['groups'] == 1 and dom2['count'].startswith('2 ') and dom2['toolMsgs'] == 2, dom2)
    check('c1 状态翻成 done', dom2['c1'] == 'done', dom2['c1'])
    check('c2 仍标记运行中', dom2['running'] == 1, dom2)

    # ---- 场景 C：失败标记 + 展开态 ----
    page.evaluate(FIRE, ['tool.failed', {'event': 'tool.failed', 'session_id': sid,
                                         'run_id': 'TESTRUN_A', 'tool': 'patch',
                                         'tool_call_id': 'c3', 'error': 'boom'}])
    page.evaluate("state.expandedRuns['TESTRUN_A'] = true; renderMsgs();")
    dom3 = page.evaluate("""() => {
        const row = document.querySelector('#msg-list .tool-run-row');
        return { count: row.querySelector('.tool-run-count').textContent,
                 errBadge: !!row.querySelector('.tool-run-badge'),
                 states: [...document.querySelectorAll('#msg-list .tool-run-expand .t-state')].map(s => s.textContent),
                 names: [...document.querySelectorAll('#msg-list .tool-run-expand .t-name')].map(s => s.textContent) };
    }""")
    check('第 3 条也并进同一组', dom3['count'].startswith('3 '), dom3['count'])
    check('组上有错误角标', dom3['errBadge'], dom3)
    check('展开列表标出 运行中/失败', '运行中' in dom3['states'] and '失败' in dom3['states'], dom3['states'])
    check('展开列表含全部 3 个工具', dom3['names'] == ['terminal', 'read_file', 'patch'], dom3['names'])
    page.screenshot(path=OUT + '/02-live-group-expanded.png')

    # ---- 场景 D：run.completed 收尾 ----
    page.evaluate(FIRE, ['run.completed', {'event': 'run.completed', 'session_id': sid,
                                           'run_id': 'TESTRUN_A', 'output': 'done'}])
    check('run.completed 后没有残留「运行中」',
          page.evaluate("document.querySelectorAll('#msg-list .tool-run-running').length") == 0)
    page.screenshot(path=OUT + '/03-after-completed.png')

    # ---- 场景 E：中途打开（历史 run_marker 与 live run_id 不同） ----
    page.evaluate("""() => {
        state.msgs = [
          { key: 'h1', role: 'user', content: 'hi', ts: Date.now() / 1000 },
          { key: 'h2', role: 'tool', tool: 'terminal', content: 'ls', runMarker: 'cli_run_HIST', status: 'done', ts: Date.now() / 1000 },
        ];
        state.activeRunId = ''; state.lastHistoryRun = 'cli_run_HIST';
        renderMsgs();
        __fire('resumed', { session_id: state.cur, isWorking: true, messages: [], model: '', contextTokens: 0 });
    }""")
    check('resumed 用历史 run_marker 对齐 activeRunId',
          page.evaluate("state.activeRunId") == 'cli_run_HIST', page.evaluate("state.activeRunId"))
    page.evaluate(FIRE, ['tool.started', {'event': 'tool.started', 'session_id': sid,
                                          'run_id': 'BRIDGE_RUN_9', 'tool': 'grep',
                                          'tool_call_id': 'k1', 'preview': 'foo'}])
    dom5 = page.evaluate("""() => {
        const g = document.querySelectorAll('#msg-list .tool-run-row');
        return { groups: g.length, count: g[0] ? g[0].querySelector('.tool-run-count').textContent : '',
                 loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length };
    }""")
    check('中途打开：增量条目并入历史那一组（1 组 2 条）',
          dom5['groups'] == 1 and dom5['count'].startswith('2 '), dom5)
    check('中途打开：无散落单条工具行', dom5['loose'] == 0, dom5)
    page.screenshot(path=OUT + '/04-midrun-merge.png')

    if logs:
        print('--- 页面错误 ---')
        for line in logs[-10:]:
            print(line)
    browser.close()

print('FAILED: ' + ', '.join(fails) if fails else 'ALL_PASS')
