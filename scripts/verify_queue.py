"""验证排队（followed）会话显示 + ⬆️ 插入会话按钮：
1. 打开会话 → resumed 带 queueMessages → 队列区渲染
2. 点 ⬆️ → 该条从队列移除并作为 user 消息插入会话
3. 队列区消失
"""
import json
import os

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-fix'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');"
        "localStorage.setItem('hm_user', 'Enderiose');"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(
        status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4000)

    # 打开一个会话
    page.locator('#session-list .row').first.click()
    page.wait_for_timeout(3000)

    print('=== 1. 注入队列快照，验证渲染 ===')
    page.evaluate("""() => {
      applyQueueSnapshot({ queueMessages: [
        { id: 'q1', role: 'user', content: '第一条排队：分析这个接口', timestamp: Math.floor(Date.now()/1000) },
        { id: 'q2', role: 'user', content: '第二条排队：然后写单元测试', timestamp: Math.floor(Date.now()/1000) },
      ]});
      renderMsgs();
    }""")
    page.wait_for_timeout(600)
    q = page.evaluate("""() => {
      const sec = document.querySelector('.queue-section');
      const items = [...document.querySelectorAll('.queued-item')];
      const btns = [...document.querySelectorAll('.queue-send-btn')];
      return {
        sectionVisible: !!sec && getComputedStyle(sec).display !== 'none',
        title: sec ? sec.querySelector('.queue-title').textContent : null,
        items: items.length,
        btns: btns.length,
        firstBtnText: btns[0] ? btns[0].textContent : null,
      };
    }""")
    print('  队列区可见:', q['sectionVisible'])
    print('  标题:', q['title'])
    print('  排队条数:', q['items'], ' ⬆️ 按钮数:', q['btns'], ' 按钮文案:', q['firstBtnText'])
    page.screenshot(path=OUT + '/60-queue.png')

    print()
    print('=== 2. 点 ⬆️ 插入会话 ===')
    page.evaluate("""() => {
      // 直接调 sendQueuedNow（绕过 isTrusted），记录发送行为
      window.__emitted = [];
      const sock = state.socket;
      const orig = sock.emit.bind(sock);
      sock.emit = function(ev, body) { window.__emitted.push({ ev, body }); return orig(ev, body); };
      sendQueuedNow('q1');
    }""")
    page.wait_for_timeout(700)
    n = page.evaluate("""() => ({
      queuedLeft: state.queued.length,
      emitted: window.__emitted,
      userMsgs: document.querySelectorAll('#msg-list .msg.user').length,
    })""")
    print('  剩余排队:', n['queuedLeft'], '(应剩 1)')
    print('  emit 记录:', json.dumps(n['emitted'], ensure_ascii=False)[:200])
    print('  user 消息数:', n['userMsgs'])
    page.screenshot(path=OUT + '/61-after-send.png')

    print()
    print('=== 3. 队列区应只剩 1 条 ===')
    left = page.evaluate("() => [...document.querySelectorAll('.queued-item')].length")
    print('  剩余 queued-item:', left, '(应剩 1)')

    print()
    print('=== 页面错误 ===', errs[-4:] if errs else '无')
    browser.close()
print('\nQUEUE_DONE')
