"""验证会话顶部上下文用量条。"""
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

    print('=== 打开 3 个会话看上下文条 ===')
    rows = page.locator('#session-list .row')
    for i in range(min(3, rows.count())):
        rows.nth(i).click()
        page.wait_for_timeout(3200)
        info = page.evaluate("""() => {
          const t = document.getElementById('ctx-text');
          const f = document.getElementById('ctx-fill');
          const bar = document.getElementById('ctx-bar');
          return {
            visible: !!bar && getComputedStyle(bar).display !== 'none',
            text: t ? t.textContent : null,
            cls: t ? t.className : null,
            width: f ? f.style.width : null,
            fillCls: f ? f.className : null,
            title: document.getElementById('chat-title').textContent.slice(0, 30),
          };
        }""")
        print('\n[%s]' % info['title'])
        print('  条可见:', info['visible'])
        print('  文本  :', info['text'])
        print('  样式  :', info['cls'], '| fill', info['fillCls'], '| width', info['width'])
        page.screenshot(path=OUT + ('/20-ctx-%d.png' % i))
        page.click('#chat-back')
        page.wait_for_timeout(1000)

    print()
    print('=== 阈值着色校验（直接调 renderContextBar）===')
    for used, limit, label in [(1000, 256000, '低 (<60%)'), (180000, 256000, '中 (>60%)'), (240000, 256000, '高 (>80%)')]:
        page.evaluate("([u,l]) => renderContextBar(u,l)", [used, limit])
        page.wait_for_timeout(200)
        r = page.evaluate("""() => ({
          text: document.getElementById('ctx-text').textContent,
          cls: document.getElementById('ctx-text').className,
          w: document.getElementById('ctx-fill').style.width,
          fcls: document.getElementById('ctx-fill').className,
        })""")
        print('  %-12s -> %s | %s | width=%s | %s' % (label, r['text'], r['cls'], r['w'], r['fcls']))

    print()
    print('=== 页面错误 ===')
    print('  ', errs[-5:] if errs else '无')
    browser.close()
print('\nCTX_DONE')
