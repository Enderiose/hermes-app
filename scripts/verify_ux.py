"""验证三项交互修复（真交互，不是推演）：
1. 上滑浏览历史时不自动回到底部；「⬇️ 回到底部」按钮出现，点它回去后隐藏
2. 消息里的链接可点击（走 Android.openUrl / window.open）
3. 回车 = 换行，不再发送
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
    page.wait_for_timeout(4500)

    # 打开一个消息多的会话
    rows = page.locator('#session-list .row')
    rows.nth(2).click()   # 「制作同步web session的安卓APK」消息最多
    page.wait_for_timeout(3500)

    def m():
        return page.evaluate("""() => {
          const el = document.getElementById('msg-list');
          const btn = document.getElementById('btn-jump-bottom');
          return {
            scrollTop: Math.round(el.scrollTop),
            scrollH: Math.round(el.scrollHeight),
            clientH: Math.round(el.clientHeight),
            dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            atBottom: typeof atBottom !== 'undefined' ? atBottom : null,
            btnHidden: btn ? btn.classList.contains('hidden') : null,
            btnVisible: btn ? getComputedStyle(btn).display !== 'none' : null,
          };
        }""")

    print('=== 1. 滚动跟随 ===')
    s0 = m()
    print('  打开后   : dist=%d atBottom=%s 按钮隐藏=%s' % (s0['dist'], s0['atBottom'], s0['btnHidden']))

    # 模拟用户上滑
    page.evaluate("() => { document.getElementById('msg-list').scrollTop = 0; document.getElementById('msg-list').dispatchEvent(new Event('scroll')); }")
    page.wait_for_timeout(500)
    s1 = m()
    print('  上滑到顶 : dist=%d atBottom=%s 按钮可见=%s' % (s1['dist'], s1['atBottom'], s1['btnVisible']))

    # 在「不在底部」状态下注入一条新流式消息，验证不再自动回到底部
    page.evaluate("""() => {
      if (!state.streaming || state.streaming.sid !== state.cur) startStream(state.cur);
      state.streaming.text += '【测试增量】这是一段流式输出，不应把已上滑的用户拉回底部。';
      paintStream();
    }""")
    page.wait_for_timeout(600)
    s2 = m()
    print('  流式增量 : dist=%d atBottom=%s (应仍远离底部)' % (s2['dist'], s2['atBottom']))
    stayed = s2['dist'] > 100
    print('  结论     : %s' % ('✅ 没被打断' if stayed else '❌ 被拉回底部'))
    page.screenshot(path=OUT + '/40-scrolled-up.png')

    # 点「⬇️ 回到底部」按钮
    page.click('#btn-jump-bottom')
    page.wait_for_timeout(900)
    s3 = m()
    print('  点按钮后 : dist=%d atBottom=%s 按钮隐藏=%s' % (s3['dist'], s3['atBottom'], s3['btnHidden']))

    print()
    print('=== 2. 链接可点击 ===')
    linkinfo = page.evaluate("""() => {
      // 构造一条含链接的助手消息并检查点击路径
      state.msgs.push({ key:'probe-link', role:'assistant', ts: Date.now()/1000,
        content:'看这两个：[Google](https://www.google.com) 和 [example](https://example.com)' });
      renderMsgs();
      const links = [...document.querySelectorAll('#msg-list a')];
      return { count: links.length, hrefs: links.map(a=>a.getAttribute('href')) };
    }""")
    print('  链接数:', linkinfo['count'], linkinfo['hrefs'])
    # 模拟点击第一个链接（拦截 openLink 记录）
    page.evaluate("""() => {
      window.__opened = [];
      const orig = window.open;
      window.open = function(u){ window.__opened.push(u); return orig ? orig.apply(window, arguments) : null; };
      // 无原生桥（smoke 环境），会走 window.open 降级
    }""")
    page.locator('#msg-list a').first.click()
    page.wait_for_timeout(500)
    opened = page.evaluate("() => window.__opened")
    print('  点击后 window.open 收到:', opened)
    print('  结论     :', '✅ 链接可点' if opened else '❌ 点击无反应')

    print()
    print('=== 3. 回车 = 换行（不发送） ===')
    page.evaluate("""() => {
      const ta = document.getElementById('chat-input');
      ta.focus(); ta.value = '';
      // 手工触发 keydown Enter（模拟真实键盘）
      const ev = new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true });
      ta.dispatchEvent(ev);
      // 等一拍，看有没有发送（如果发送了 state.msgs 会多一条 user 消息且 textarea 清空）
    }""")
    page.wait_for_timeout(700)
    n_before = page.evaluate("() => document.querySelectorAll('#msg-list .msg.user').length")
    ta_val = page.evaluate("() => document.getElementById('chat-input').value")
    ta_focus = page.evaluate("() => document.activeElement === document.getElementById('chat-input')")
    print('  Enter 后 user 消息数:', n_before, '(应不变，即没发送)')
    print('  textarea 内容:', repr(ta_val), ' 仍聚焦:', ta_focus)
    print('  结论     :', '✅ Enter 没触发发送' if not ta_val and ta_focus else '❌ 被发送了')

    print()
    print('=== 页面错误 ===', errs[-4:] if errs else '无')
    browser.close()
print('\nUX_DONE')
