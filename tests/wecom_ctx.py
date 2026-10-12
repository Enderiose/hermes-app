"""企微会话的上下文用量条（回归：曾恒为 0）。

企微会话是 hermes-history 会话：不走 socket `resumed`（服务端没有它的 run 状态），
`/api/studio/sessions/:id/usage` 也查不到（studio 库不记录 gateway 侧用量），
所以老的 `loadContextUsage()` 两条路都拿到 0 → 顶部条恒显示「上下文 0 / 1.0M」。

断言：打开企微标签下每个会话，用量 > 0，且与
`GET /api/studio/sessions/hermes/:id` 的 input_tokens+output_tokens 一致（web 同口径）。

用法：/opt/hermes/.venv/bin/python tests/wecom_ctx.py
"""
import json
import os
import urllib.request

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
PROFILE = 'enderiose'
INLINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      'app/assets/www/inline.html')
OUT = '/tmp/apk-fix'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()


def api(path):
    req = urllib.request.Request(BASE + path, headers={
        'Authorization': 'Bearer ' + TOKEN,
        'X-Hermes-Profile': PROFILE,
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def fmt(n):
    if n >= 1000000:
        return '%.1fM' % (n / 1000000)
    if n >= 1000:
        return '%.1fk' % (n / 1000)
    return str(round(n))


READ = """() => {
  const t = document.getElementById('ctx-text');
  return {
    text: t ? t.textContent : null,
    cls: t ? t.className : null,
    title: document.getElementById('chat-title').textContent.slice(0, 30),
  };
}"""

failures = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', %s);"
        "localStorage.setItem('hm_user', 'Enderiose');"
        % (json.dumps(BASE), json.dumps(TOKEN), json.dumps(PROFILE)))
    ctx.route('**/__app__', lambda r: r.fulfill(
        status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4000)

    page.click('.tabbar .tab[data-tab="wecom"]')
    page.wait_for_timeout(2500)
    rows = page.locator('#wecom-list .row')
    n = rows.count()
    print('企微会话行数:', n)

    for i in range(min(3, n)):
        sid = rows.nth(i).get_attribute('data-id')
        rows.nth(i).click()
        page.wait_for_timeout(3500)
        info = page.evaluate(READ)
        expect = api('/api/studio/sessions/hermes/%s?profile=%s' % (sid, PROFILE))['session']
        want = int(expect.get('input_tokens') or 0) + int(expect.get('output_tokens') or 0)
        print('\n[%s] %s' % (info['title'], sid))
        print('  上下文条:', info['text'])
        print('  期望用量: %s (in+out = %s)' % (fmt(want), want))
        if want <= 0:
            print('  ⚠️ 服务端该会话 in+out 也是 0，跳过')
        elif info['text'] and fmt(want) in info['text']:
            print('  ✅ 与 in+out 一致')
        else:
            print('  ❌ 不一致')
            failures.append(sid)
        page.screenshot(path=OUT + ('/wecom-ctx-%d.png' % i))
        page.click('#chat-back')
        page.wait_for_timeout(1200)

    print('\n页面错误:', errs[-5:] if errs else '无')
    browser.close()

print('\n结果:', 'FAIL ' + ','.join(failures) if failures else 'PASS')
print('WECOM_CTX_DONE')
