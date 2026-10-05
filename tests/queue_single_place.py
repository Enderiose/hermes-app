"""验证排队消息只待在排队区，开跑后才进消息流（不再两处同时出现）。

场景：发 A（一次带 sleep 的长运行）→ A 还在跑时发 B → B 应只出现在「排队中」；
A 跑完、B 开跑 → B 从排队区挪进消息流，且全流程只出现一次。用完即删测试会话。
"""
import json
import os
from urllib import request as urlreq

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-queue'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

A = '先跑一条命令：`sleep 9 && echo A-done`，拿到结果后只回复两个字：甲'
B = '第二条消息-排队验证-B'

fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' | ' + str(detail) if detail else ''))
    if not cond:
        fails.append(name)


def api(method, path):
    req = urlreq.Request(BASE + path, method=method,
                         headers={'Authorization': 'Bearer ' + TOKEN,
                                  'Content-Type': 'application/json',
                                  'X-Hermes-Profile': 'enderiose'})
    with urlreq.urlopen(req, timeout=20) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def session_row(sid):
    lst = api('GET', '/api/studio/sessions?profile=enderiose&limit=200').get('sessions') or []
    return next((s for s in lst if s['id'] == sid), None)


SNAP = """() => ({
    userBubbles: [...document.querySelectorAll('#msg-list .msg.user:not(.queued-item) .bubble')].map(e => e.innerText.trim()),
    streamMsgs: state.msgs.filter(m => m.role === 'user').map(m => String(m.content || '').trim()),
    queuedItems: [...document.querySelectorAll('#msg-list .queue-section .queued-item .bubble')].map(e => e.innerText.trim()),
    queued: state.queued.length,
    queueTitle: (document.querySelector('#msg-list .queue-title') || {}).textContent || '',
    sub: document.getElementById('chat-sub').textContent,
    streaming: !!state.streaming,
    working: !!state.working[state.cur],
})"""

sid = None
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'queue');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4000)
    check('socket 已连接', bool(page.evaluate("!!(state.socket && state.socket.connected)")))

    page.click('#fab-new')
    page.wait_for_timeout(900)
    sid = page.evaluate('state.cur')
    print('测试会话:', sid)

    # A：长运行
    page.fill('#chat-input', A)
    page.click('#chat-send')
    for _ in range(20):
        page.wait_for_timeout(500)
        if page.evaluate("!!state.working[state.cur] || !!state.streaming"):
            break
    check('A 已在跑（会话处于忙碌态）', page.evaluate("!!state.working[state.cur] || !!state.streaming"))

    # B：A 还在跑时发第二条
    page.fill('#chat-input', B)
    page.click('#chat-send')
    page.wait_for_timeout(2500)
    s1 = page.evaluate(SNAP)
    print('排队期快照:', json.dumps(s1, ensure_ascii=False))
    check('B 不在已发送消息流里', not any(B in t for t in s1['userBubbles']) and not any(B in c for c in s1['streamMsgs']), {'dom': s1['userBubbles'], 'msgs': s1['streamMsgs']})
    check('B 出现在排队区', any(B in t for t in s1['queuedItems']), s1['queuedItems'])
    check('排队区标题是「排队中」', '排队中' in s1['queueTitle'], s1['queueTitle'])
    check('state.queued 恰好一条', s1['queued'] == 1, s1)
    check('副标题提示排队中', '排队中' in s1['sub'], s1['sub'])
    page.screenshot(path=OUT + '/01-queued-only.png')

    # 等 A 跑完 → 服务端取出 B（run.queued 带 dequeued_queue_id）→ B 挪进消息流
    promoted = False
    s2 = s1
    for _ in range(60):
        page.wait_for_timeout(1000)
        s2 = page.evaluate(SNAP)
        if any(B in t for t in s2['userBubbles']) and not s2['queued']:
            promoted = True
            break
    print('迁移后快照:', json.dumps(s2, ensure_ascii=False))
    check('B 开跑后进入消息流', promoted, s2)
    check('B 在消息流里只出现一次', sum(1 for t in s2['userBubbles'] if B in t) == 1, s2['userBubbles'])
    check('不会两处同时出现', not (any(B in t for t in s2['userBubbles']) and s2['queued']), s2)
    check('排队区已清空', s2['queued'] == 0 and not s2['queuedItems'], s2['queuedItems'])
    page.screenshot(path=OUT + '/02-promoted.png')

    # 等 B 跑完
    for _ in range(40):
        page.wait_for_timeout(1000)
        if not page.evaluate("!!state.streaming || !!state.working[state.cur]"):
            break
    s3 = page.evaluate(SNAP)
    check('跑完后 B 仍只有一条', sum(1 for t in s3['userBubbles'] if B in t) == 1, s3['userBubbles'])

    # 重开会话（历史路径）：B 依然只有一条
    page.evaluate("closeChat()")
    page.wait_for_timeout(1500)
    page.evaluate("""async () => { await loadSessions(); await openSession(%s, '', false, ''); }""" % json.dumps(sid))
    page.wait_for_timeout(5000)
    hist = page.evaluate("""() => ({
        bubbles: [...document.querySelectorAll('#msg-list .msg.user:not(.queued-item) .bubble')].map(e => e.innerText.trim()),
        queued: state.queued.length,
    })""")
    check('重开会话后 B 也只有一条（无重复）', sum(1 for t in hist['bubbles'] if B in t) == 1, hist['bubbles'])
    check('重开会话后没有残留排队条目', hist['queued'] == 0, hist)
    page.screenshot(path=OUT + '/03-reopened.png')

    if errs:
        print('--- 页面错误 ---')
        for e in errs[-6:]:
            print(e)
    browser.close()

if sid:
    try:
        api('DELETE', '/api/studio/sessions/%s?profile=enderiose' % sid)
        check('测试会话已删除', session_row(sid) is None)
    except Exception as e:
        check('测试会话已删除', False, str(e))

print('FAILED: ' + ', '.join(fails) if fails else 'ALL_PASS')
