"""探针：socket 连接状态 + 真实 run 的 live 事件 payload（看是否带 run_id / run_marker）。"""
import json
import sys

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
HTML = open('/home/agent/.hermes/hermes-app/app/assets/www/inline.html', encoding='utf-8').read()

with sync_playwright() as p:
    b = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844})
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'probe');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    page.on('pageerror', lambda e: print('PAGEERROR:', e))
    page.goto(BASE + '/__app__')
    for i in range(8):
        page.wait_for_timeout(1500)
        st = page.evaluate("""() => ({
            conn: document.getElementById('set-conn') ? document.getElementById('set-conn').textContent : '',
            connected: !!(state.socket && state.socket.connected),
            id: state.socket ? state.socket.id : null,
            view: state.view })""")
        print(i, st)
        if st['connected']:
            break
    b.close()
