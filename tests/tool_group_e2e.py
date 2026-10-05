"""真机路径端到端验证：真实 run 期间，增量工具调用是否当场并进整合行。

用打包进 APK 的 inline.html（同源挂载），连真服务端、真 socket、真 run。
测试会话跑完即删（DELETE /api/studio/sessions/:id）。
"""
import json
import os
import time
from urllib import request as urlreq

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-toolgroup'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

PROMPT = ('用 terminal 跑这 4 条命令并各回一行结果（第 1 条要原样执行）：'
          '`sleep 5 && echo slow-ok`、`cat /home/agent/.hermes/hermes-app/VERSION`、'
          '`ls /home/agent/.hermes/hermes-app/tests`、`date +%s`；最后只回复两个字：完成')

fails = []
sid = None


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' | ' + str(detail) if detail else ''))
    if not cond:
        fails.append(name)


def api(method, path, body=None):
    req = urlreq.Request(BASE + path, method=method,
                         data=json.dumps(body).encode() if body is not None else None,
                         headers={'Authorization': 'Bearer ' + TOKEN,
                                  'Content-Type': 'application/json',
                                  'X-Hermes-Profile': 'enderiose'})
    with urlreq.urlopen(req, timeout=20) as r:
        raw = r.read().decode()
    try:
        return json.loads(raw)
    except Exception:
        return raw


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'e2e');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4000)
    check('socket 已连接', bool(page.evaluate("!!(state.socket && state.socket.connected)")),
          page.evaluate("document.getElementById('set-conn').textContent"))

    # 新会话（客户端生成 id，服务端首次 run 时落库）
    page.click('#fab-new')
    page.wait_for_timeout(1200)
    sid = page.evaluate('state.cur')
    print('测试会话:', sid)
    # 抓一份真实 tool.started 事件，确认 payload 里到底有没有 run_id / run_marker
    page.evaluate("""() => {
        state.socket.on('tool.started', ev => { (window.__toolEvs = window.__toolEvs || []).push(ev); });
        state.socket.on('run.started', ev => { window.__runEv = ev; });
    }""")
    page.fill('#chat-input', PROMPT)
    page.click('#chat-send')

    samples = []
    peak = None
    deadline = time.time() + 180
    while time.time() < deadline:
        page.wait_for_timeout(700)
        s = page.evaluate("""() => {
            const g = [...document.querySelectorAll('#msg-list .tool-run-row')];
            return {
              groups: g.length,
              count: g.length ? g[0].querySelector('.tool-run-count').textContent : '',
              running: document.querySelectorAll('#msg-list .tool-run-running').length,
              loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length,
              toolMsgs: state.msgs.filter(m => m.role === 'tool').length,
              markers: [...new Set(state.msgs.filter(m => m.role === 'tool').map(m => m.runMarker || ''))],
              statuses: state.msgs.filter(m => m.role === 'tool').map(m => m.tool + ':' + (m.status || '')),
              working: !!document.querySelector('#msg-list .bubble.caret'),
              sub: document.getElementById('chat-sub').textContent,
            };
        }""")
        samples.append(s)
        n = int((s['count'] or '0 ').split(' ')[0] or 0)
        if peak is None or n > peak:
            peak = n
        if len(samples) % 4 == 1 or s['loose'] or s['running']:
            print('  t+%.1fs %s' % (len(samples) * 0.7, {k: s[k] for k in ('groups', 'count', 'running', 'loose', 'toolMsgs', 'markers', 'statuses')}))
        if peak >= 3 and s['loose'] == 0 and s['running'] == 0 and not s['working']:
            break

    check('真实 run 期间出现整合行', any(x['groups'] == 1 for x in samples), [x['groups'] for x in samples])
    check('整合行条目数增量到 >=2（live 期间，未切窗口/未重开会话）', peak >= 2, peak)
    check('全程无散落的单条工具行', all(x['loose'] == 0 for x in samples), [x['loose'] for x in samples])
    check('live 期间出现「运行中」标记', any(x['running'] for x in samples), [x['running'] for x in samples])
    check('live 工具行只带一个归组键', all(len([m for m in x['markers'] if m]) <= 1 for x in samples),
          [x['markers'] for x in samples])

    evs = page.evaluate("window.__toolEvs || []")
    keys = sorted({k for e in evs for k in e.keys()}) if evs else []
    print('tool.started 事件数:', len(evs), '字段:', keys)
    check('tool.started 带 run_id', 'run_id' in keys, keys)
    print('run.started 字段:', sorted(page.evaluate("window.__runEv ? Object.keys(window.__runEv) : []")))
    page.screenshot(path=OUT + '/05-e2e-live.png', full_page=True)

    # 等 run 收尾
    for _ in range(20):
        page.wait_for_timeout(1500)
        if not page.evaluate("!!document.querySelector('#msg-list .bubble.caret')"):
            break
    final = page.evaluate("""() => {
        const g = document.querySelectorAll('#msg-list .tool-run-row');
        return { groups: g.length, count: g[0] ? g[0].querySelector('.tool-run-count').textContent : '',
                 loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length,
                 tail: document.getElementById('msg-list').innerText.slice(-160) };
    }""")
    print('收尾:', final)
    check('收尾后仍是 1 个整合行', final['groups'] == 1, final)
    check('收尾后无「运行中」残留', page.evaluate("document.querySelectorAll('#msg-list .tool-run-running').length") == 0)
    page.screenshot(path=OUT + '/06-e2e-done.png', full_page=True)

    # 对照：重开同一会话（走历史 run_marker 路径）应得到同样一条整合行
    page.evaluate("closeChat()")
    page.wait_for_timeout(800)
    page.evaluate("""async () => {
        await loadSessions();
        await openSession(%s, '', false, '');
    }""" % json.dumps(sid))
    page.wait_for_timeout(4000)
    hist = page.evaluate("""() => {
        const g = document.querySelectorAll('#msg-list .tool-run-row');
        return { groups: g.length, count: g[0] ? g[0].querySelector('.tool-run-count').textContent : '',
                 loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length };
    }""")
    print('重开（历史）:', hist)
    check('历史路径同样 1 条整合行（live 与历史结果一致）', hist['groups'] == 1, hist)
    check('历史路径无散落单条', hist['loose'] == 0, hist)
    hist_n = int((hist['count'] or '0 ').split(' ')[0] or 0)
    check('live 计数 == 历史计数（同一次调用不重复计数）', hist_n == peak, 'live=%s hist=%s' % (peak, hist_n))
    page.screenshot(path=OUT + '/07-reopen-history.png', full_page=True)

    if errs:
        print('--- 页面错误 ---')
        for e in errs[-6:]:
            print(e)
    browser.close()

# ---- 清理测试会话 ----
if sid:
    try:
        api('DELETE', '/api/studio/sessions/%s?profile=enderiose' % sid)
        lst = api('GET', '/api/studio/sessions?profile=enderiose&limit=200')
        ids = [s.get('id') for s in (lst.get('sessions') or [])]
        gone = sid not in ids
        check('测试会话已删除', gone, '仍在列表中' if not gone else '')
    except Exception as e:
        check('测试会话已删除', False, 'cleanup error: %s' % e)

print('FAILED: ' + ', '.join(fails) if fails else 'ALL_PASS')
