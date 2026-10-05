"""冒烟测试：在“与 Studio 同源”的页面上跑打包进 APK 的那份内联 UI。

Android 端用 loadDataWithBaseURL(服务器 origin, inline.html) 加载页面，这里用 Playwright 的
route 拦截伪造同一个 URL（http://<server>/__app__），因此 origin 与真机完全一致：
不依赖 --disable-web-security，能真实检验 socket.io origin 校验、REST 同源请求。
"""
import json
import os

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-smoke'
os.makedirs(OUT, exist_ok=True)

HTML = open(INLINE, encoding='utf-8').read()

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');"
        "localStorage.setItem('hm_user', 'smoke');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN))
    )

    def app_route(route):
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML)

    ctx.route('**/__app__', app_route)

    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append('CONSOLE %s: %s' % (m.type, m.text)))
    page.on('pageerror', lambda e: logs.append('PAGEERROR: %s' % e))

    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4500)
    page.screenshot(path=OUT + '/01-sessions.png')

    rows = page.locator('#session-list .row')
    print('会话行数:', rows.count())
    print('首行:', (rows.first.inner_text().replace('\n', ' | ') if rows.count() else 'N/A')[:140])
    print('sessions 视图可见:', page.locator('#view-sessions').is_visible())

    page.click('#view-sessions .tab[data-tab="settings"]')
    page.wait_for_timeout(1000)
    print('连接状态:', page.locator('#set-conn').inner_text())
    page.screenshot(path=OUT + '/02-settings.png')

    page.click('#view-settings .tab[data-tab="sessions"]')
    page.wait_for_timeout(800)
    if rows.count():
        rows.first.click()
        page.wait_for_timeout(4000)
        print('聊天视图可见:', page.locator('#view-chat').is_visible())
        print('标题:', page.locator('#chat-title').inner_text())
        print('副标题:', page.locator('#chat-sub').inner_text())
        print('消息元素数:', page.locator('#msg-list .msg, #msg-list .tool-row').count())
        page.screenshot(path=OUT + '/03-chat.png')

    page.click('#chat-back')
    page.wait_for_timeout(700)
    page.click('#view-sessions .tab[data-tab="wecom"]')
    page.wait_for_timeout(2500)
    wrows = page.locator('#wecom-list .row')
    print('企微会话行数:', wrows.count())
    print('企微首行:', (wrows.first.inner_text().replace('\n', ' | ') if wrows.count() else 'N/A')[:140])
    page.screenshot(path=OUT + '/04-wecom.png')

    # 新建会话界面（不发消息，只验证交互与模型列表）
    page.click('#view-wecom .tab[data-tab="sessions"]')
    page.wait_for_timeout(600)
    page.click('#fab-new')
    page.wait_for_timeout(1500)
    print('新会话标题:', page.locator('#chat-title').inner_text())
    page.click('#chat-model')
    page.wait_for_timeout(2500)
    items = page.locator('#model-list .model-item')
    print('模型条目数:', items.count())
    if items.count():
        print('模型样例:', items.first.inner_text().replace('\n', ' / '))
    page.screenshot(path=OUT + '/05-new-session.png')

    print('--- 浏览器日志 ---')
    for line in logs[-20:]:
        print(line)

    browser.close()
print('SMOKE_DONE')
