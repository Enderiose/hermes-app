"""排队消息「插队」后不应重复显示（回归测试）。

背景（用户 2026-10-05 截图报的 bug）：App 在会话运行中发送 → 消息进排队区；
点 ⬆️ 插队后，界面上出现**两条一模一样**的消息。

根因（服务端侧）：`insert_queued_run` 最终走 `runQueuedItem`，回推对端消息时排除的是
**当初投递那条排队消息的 socket.id**（`peerExcludeSocketId = next.originSocketId`）。
App 一旦在排队与插队之间断线重连（后台被杀/切网/换 WiFi），socket.id 就变了，
排除失效 → 客户端收到自己的 `run.peer_user_message`；而它已经通过
`run.queued(dequeued_queue_id)` 把这条 promote 进了消息流 → 两条。

修复（客户端）：`run.peer_user_message` 按 `message.id`（服务端填的就是 queue_id）与
`msg.queueId` 精确去重。**不能**按内容去重——用户连发两条相同内容的话是合法操作。

断言以 `state.msgs` 为准（DOM 计数只作旁证）。

用法：
    PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
      /opt/hermes/.venv/bin/python tests/queue_insert_no_dup.py          # 只跑修复后（快）
      /opt/hermes/.venv/bin/python tests/queue_insert_no_dup.py --ab     # 同时跑 control（旧行为，慢一倍）
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
HTML = open('/home/agent/.hermes/hermes-app/app/assets/www/inline.html', encoding='utf-8').read()

# 去掉去重判断 = 修复前的行为（用于 A/B 对照）
ANCHOR = "const already = mid && state.msgs.some((x) => String(x.queueId || '') === mid);"
CONTROL_HTML = HTML.replace(ANCHOR, "const already = false;")
PROBE = 'QUEUE-DUP-PROBE'


def run_case(mode):
    body = CONTROL_HTML if mode == 'control' else HTML
    sid = 'qdup-%s-%d' % (mode, int(time.time()))
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844})
        ctx.add_init_script(
            "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
            "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'probe');"
            "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
            % (json.dumps(BASE), json.dumps(TOKEN)))
        ctx.route('**/__app__',
                  lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=body))
        page = ctx.new_page()
        page.goto(BASE + '/__app__')
        page.wait_for_function(
            "() => typeof state !== 'undefined' && !!state.token && !!state.socket && state.socket.connected",
            timeout=40000)

        # 1) 全新会话
        page.evaluate("""(sid) => {
            state.cur = sid; state.curHermes = false; state.msgs = []; state.queued = [];
            state.streaming = null; state.cards = []; state.working = {};
            show('chat'); document.getElementById('chat-title').textContent = 'qdup ' + sid;
            renderMsgs();
        }""", sid)

        # 2) 真实慢 run 占住会话
        page.evaluate("""(sid) => state.socket.emit('run', {session_id: sid, profile: state.profile,
            input: '先执行 `sleep 30`，然后只回复两个字：完成'})""", sid)
        page.wait_for_function("(sid) => !!state.working[sid]", arg=sid, timeout=60000)

        # 3) 走 App 自己的发送路径 → 进排队区
        page.fill('#chat-input', PROBE)
        page.click('#chat-send')
        page.wait_for_function("() => state.queued.length === 1", timeout=25000)
        qid = page.evaluate("() => state.queued[0].id")

        # 4) 断线重连（socket.id 变化 → 服务端 originSocketId 排除失效）
        page.evaluate("() => { try { state.socket.disconnect(); } catch (e) {}"
                      "         setTimeout(() => state.socket.connect(), 800); }")
        page.wait_for_function("() => state.socket.connected", timeout=30000)
        time.sleep(4)

        # 5) 插队
        page.evaluate("(qid) => sendQueuedNow(qid)", qid)
        page.wait_for_function("() => state.queued.length === 0", timeout=120000)
        time.sleep(15)   # 对端回推可能稍晚

        res = page.evaluate("""(probe) => {
            const hits = state.msgs.filter(m => (m.content || '').includes(probe));
            return {
              copies: hits.length,
              queueIds: hits.map(m => m.queueId || null),
              domCopies: Array.from(document.querySelectorAll('.msg.user .bubble'))
                            .filter(e => (e.textContent || '').includes(probe)).length,
            };
        }""", PROBE)

        page.evaluate("""async ({base, token, sid}) => {
            await fetch(base + '/api/studio/sessions/' + sid + '?profile=enderiose',
                        {method: 'DELETE', headers: {Authorization: 'Bearer ' + token}});
        }""", {"base": BASE, "token": TOKEN, "sid": sid})
        b.close()
    return res


ab = '--ab' in sys.argv
res = run_case('fixed')
print('[fixed] copies=%d domCopies=%d queueIds=%s' % (res['copies'], res['domCopies'], res['queueIds']))
ok = res['copies'] == 1 and res['domCopies'] == 1
if ab:
    cres = run_case('control')
    print('[control] copies=%d domCopies=%d queueIds=%s' % (cres['copies'], cres['domCopies'], cres['queueIds']))
    ok = ok and cres['copies'] >= 2
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
