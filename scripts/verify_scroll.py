"""验证：打开会话后应定位到最下方（最新消息可见），而不是停在第一条。"""
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
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(
        status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4500)

    rows = page.locator('#session-list .row')
    n = min(rows.count(), 4)
    print('测试前 %d 个会话：' % n)
    for i in range(n):
        title = rows.nth(i).locator('.row-title').inner_text()
        # 先展开分组以保证可点
        rows.nth(i).scroll_into_view_if_needed()
        rows.nth(i).click()
        page.wait_for_timeout(3000)

        m = page.evaluate("""() => {
          const el = document.getElementById('msg-list');
          const kids = el.querySelectorAll('.msg, .tool-row');
          const last = kids[kids.length - 1];
          const lr = last ? last.getBoundingClientRect() : null;
          return {
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: Math.round(el.scrollHeight),
            clientHeight: Math.round(el.clientHeight),
            distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            lastVisible: lr ? (lr.top < window.innerHeight && lr.bottom > 0) : null,
            lastText: last ? last.innerText.replace(/\\s+/g,' ').slice(0, 60) : null,
            total: kids.length,
          };
        }""")
        ok = m['distFromBottom'] <= 12 and m['lastVisible']
        print('\n[%s]' % title[:34])
        print('   scrollTop=%d  scrollHeight=%d  clientHeight=%d' %
              (m['scrollTop'], m['scrollHeight'], m['clientHeight']))
        print('   距底部=%d px   最后一条可见=%s   %s' %
              (m['distFromBottom'], m['lastVisible'], '✅ OK' if ok else '❌ FAIL'))
        print('   最后一条: %s' % m['lastText'])
        page.screenshot(path=OUT + ('/scroll-%d.png' % i))
        page.click('#chat-back')
        page.wait_for_timeout(1200)

    browser.close()
print('\nSCROLL_DONE')
