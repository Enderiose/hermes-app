"""探针：会话列表的运行状态靠哪些 socket 事件同步。

背景（用户报）：会话结束后，列表里的「● 运行中」不会自己消失，点进会话再退出才消失。
猜测是漏接了服务端的 `session.activity.snapshot`（连上就发）与 `session.activity`
（广播到 `pending-interactions:<profile>` 房间）。

本探针：用真实 app 页面连上 /chat-run，录下全部 socket 事件，然后在**另一个会话**里
发一条 run（app 的 socket 不在那个 session 房间里，等价于「后台会话」），看服务端到底发什么。

用法：/opt/hermes/.venv/bin/python tests/probe_session_activity.py
"""
import json
import random
import string
import time

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
PROFILE = 'enderiose'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
HTML = open(INLINE, encoding='utf-8').read()

SID = 'mprobe' + ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))

with sync_playwright() as p:
    b = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', %s);localStorage.setItem('hm_user', 'probe');"
        % (json.dumps(BASE), json.dumps(TOKEN), json.dumps(PROFILE)))
    ctx.route('**/__app__', lambda r: r.fulfill(
        status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    page.on('pageerror', lambda e: print('PAGEERROR:', e))
    page.goto(BASE + '/__app__')
    for _ in range(10):
        page.wait_for_timeout(1500)
        if page.evaluate("() => !!(state.socket && state.socket.connected)"):
            break
    print('connected:', page.evaluate("() => state.socket.connected"))

    page.evaluate("""() => {
      window.__evts = [];
      state.socket.onAny((ev, d) => {
        let s = '';
        try { s = JSON.stringify(d); } catch (e) { s = String(d); }
        window.__evts.push([ev, s.slice(0, 220)]);
      });
    }""")

    # 在「另一个」会话里发一条 run —— app 的 socket 不在它的 session 房间
    print('emitting run in', SID)
    page.evaluate("""(sid) => state.socket.emit('run', {
      session_id: sid, profile: state.profile, queue_id: 'qprobe1',
      input: '只回复两个字：完成' })""", SID)

    for i in range(12):
        page.wait_for_timeout(5000)
        evts = page.evaluate("() => window.__evts.slice()")
        names = [e[0] for e in evts]
        interesting = [e for e in evts if e[0].startswith('session.activity')]
        print('%2ds  events=%d  activity=%d  %s' % ((i + 1) * 5, len(evts), len(interesting),
              [e[0] for e in evts][-6:]))
        if any(e[0] == 'session.activity' and '"completed"' in e[1] for e in evts):
            print('  → 收到 completed，停止等待')
            break

    print('\n=== 全部事件名 ===')
    print(sorted(set(e[0] for e in page.evaluate("() => window.__evts.slice()"))))
    print('\n=== session.activity* 明细 ===')
    for ev, data in page.evaluate("() => window.__evts.slice()"):
        if ev.startswith('session.activity'):
            print(' ', ev, data)
    print('\n=== 这条 run 自己的事件（前 12 条）===')
    for ev, data in page.evaluate("() => window.__evts.slice()")[:12]:
        print(' ', ev, data[:140])

    print('\nprobe session:', SID)
    b.close()
print('PROBE_DONE')
