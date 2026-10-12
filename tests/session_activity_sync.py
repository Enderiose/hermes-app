"""会话列表的运行状态同步（回归：会话跑完了列表还挂着「● 运行中」）。

用户报的现象：某个会话跑完之后，App 的会话列表里那条仍然显示「运行中」，
必须点进会话（触发 resume）再退出来才消失。

根因：列表的运行标记只由「当前会话的 run 事件」维护，而这些事件只发给
`session:<id>` 房间（或发起它的那个 socket）——App 切后台/断线重连后不在房间里，
`run.completed` 就永久错过；别的端发起的 run 也收不到。
服务端另发两条与房间无关的事件（chat-run.ts onConnection / emitSessionActivity）：
`session.activity.snapshot`（连上即发，权威列出在跑的会话）与 `session.activity`
（run 生命周期广播到 `pending-interactions:<profile>`，App 连上就被自动加进该房间）。

两个断言：
  A. 别的客户端发起的 run：列表**不点进会话**也能出现「运行中」，跑完自动消失。
  B. 错过完成事件（强制断线重连）后，连上时的快照把陈旧的「运行中」清掉。

用法：
  /opt/hermes/.venv/bin/python tests/session_activity_sync.py          # 跑修复后
  /opt/hermes/.venv/bin/python tests/session_activity_sync.py --ab     # 再跑一次 control（把两条事件监听禁用 = 修复前），应 FAIL
"""
import json
import random
import string
import sys
import urllib.request

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
PROFILE = 'enderiose'
HTML = open('/home/agent/.hermes/hermes-app/app/assets/www/inline.html', encoding='utf-8').read()
SID = 'mact' + ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10))
AB = '--ab' in sys.argv
if AB:
    # control：把两条活动事件改名，等价于修复前「根本没监听」的客户端
    before = HTML
    HTML = HTML.replace("on('session.activity.snapshot', ", "on('__control.snapshot', ")
    HTML = HTML.replace("on('session.activity', ", "on('__control.activity', ")
    assert HTML != before, 'control 替换失败：没找到活动事件监听'

fails = []


def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + (' | ' + str(detail) if detail != '' else ''))
    if not ok:
        fails.append(label)


def api(method, path):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'X-Hermes-Profile': PROFILE})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or '{}')


def open_app(p, tag):
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', %s);localStorage.setItem('hm_user', %s);"
        % (json.dumps(BASE), json.dumps(TOKEN), json.dumps(PROFILE), json.dumps(tag)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    page.on('pageerror', lambda e: print('PAGEERROR[' + tag + ']:', e))
    page.goto(BASE + '/__app__')
    for _ in range(12):
        page.wait_for_timeout(1200)
        if page.evaluate("() => !!(state.socket && state.socket.connected)"):
            break
    page.evaluate("""() => {
      window.__evts = [];
      state.socket.onAny((ev, d) => {
        let s = ''; try { s = JSON.stringify(d); } catch (e) { s = String(d); }
        window.__evts.push([ev, s.slice(0, 200)]);
      });
    }""")
    return browser, page


def badge(page, sid):
    """列表里那条的「● 运行中」在不在。"""
    return page.evaluate("""(sid) => {
      const row = document.querySelector('#session-list .row[data-id="' + sid + '"]');
      return !!row && !!row.querySelector('.chip.working');
    }""", sid)


print('模式:', 'control（修复前）' if AB else 'fixed（当前代码）')
with sync_playwright() as p:
    # A 端：只看列表，从不点进这个会话
    bA, pageA = open_app(p, 'watch')
    # B 端：负责发起 run（模拟「别的端/别的设备发起的 run」）
    bB, pageB = open_app(p, 'sender')

    pageA.evaluate("() => switchTab('sessions')")
    pageA.wait_for_timeout(1500)
    check('A 端在会话列表视图', pageA.evaluate("() => state.view") == 'sessions')

    print('\n--- A：别的客户端发起的 run ---')
    pageB.evaluate("""(sid) => state.socket.emit('run', {
      session_id: sid, profile: state.profile, queue_id: 'qact1',
      input: '只回复两个字：完成' })""", SID)

    appeared = False
    for _ in range(20):
        pageA.wait_for_timeout(1000)
        pageA.evaluate("() => loadSessions()")     # 让新会话进列表（App 每 30s 自己也会刷）
        pageA.wait_for_timeout(700)
        if badge(pageA, SID):
            appeared = True
            break
    check('A 端列表出现「运行中」（没点进会话）', appeared,
          'state.cur=%s' % pageA.evaluate("() => state.cur"))

    gone = False
    for _ in range(45):
        pageA.wait_for_timeout(1000)
        if not badge(pageA, SID):
            gone = True
            break
    evts = pageA.evaluate("() => window.__evts.slice()")
    via_activity = any(e[0] == 'session.activity' and '"completed"' in e[1] for e in evts)
    direct = any(e[0] == 'run.completed' for e in evts)
    check('A 端跑完自动消失（没点进会话）', gone, 'state.cur=%s' % pageA.evaluate("() => state.cur"))
    check('A 端不是靠 run.completed 直达（证明走的是活动通道）', not direct,
          'activity_completed=%s run_completed=%s' % (via_activity, direct))

    print('\n--- A：错过完成事件后，重连靠快照清陈旧标记 ---')
    pageA.evaluate("() => switchTab('sessions')")
    pageA.wait_for_timeout(1500)
    stale_id = pageA.evaluate("() => (state.sessions[0] || {}).id || ''")
    pageA.evaluate("(sid) => { state.working[sid] = true; renderSessions(); }", stale_id)
    pageA.wait_for_timeout(500)
    check('人为造出陈旧的「运行中」', badge(pageA, stale_id), stale_id)

    pageA.evaluate("() => { state.socket.disconnect(); state.socket.connect(); }")
    healed = False
    for _ in range(15):
        pageA.wait_for_timeout(1000)
        if not badge(pageA, stale_id):
            healed = True
            break
    check('重连后快照把陈旧标记清掉（无需点进会话）', healed, stale_id)

    # 收尾：删掉测试会话
    try:
        api('DELETE', '/api/studio/sessions/' + SID + '?profile=' + PROFILE)
        print('已删除测试会话', SID)
    except Exception as e:
        print('删除测试会话失败（可忽略）：', e)
    bA.close()
    bB.close()

print('\n结果:', ('FAIL ' + ','.join(fails)) if fails else 'ALL_PASS')
print('ACTIVITY_SYNC_DONE')
