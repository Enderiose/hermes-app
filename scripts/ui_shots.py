"""出包后「看一眼」用的截图脚本：用真服务端把打包进 APK 的那份 inline.html 渲染成 5 张图。

    PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright /opt/hermes/.venv/bin/python scripts/ui_shots.py [输出目录]

默认输出到 dist/shots-<VERSION>/（dist/ 已 gitignore，产物随包留档）。
每个场景单独 launch 一个浏览器：本机 chromium 需要 --single-process（见 scripts/_launch.py），
而单进程下多个 context 会卡死。
"""

import json
import os
import sys

from playwright.sync_api import sync_playwright

from _launch import LAUNCH_ARGS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('STUDIO_BASE', 'http://127.0.0.1:6060')
TOKEN = open(os.environ.get(
    'STUDIO_TOKEN_FILE',
    '/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token')).read().strip()
INLINE = os.path.join(ROOT, 'app', 'assets', 'www', 'inline.html')
VERSION = open(os.path.join(ROOT, 'VERSION'), encoding='utf-8').read().strip()
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'shots-' + VERSION)
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

LOGIN_JS = (
    "localStorage.setItem('hm_base', %s);"
    "localStorage.setItem('hm_token', %s);"
    "localStorage.setItem('hm_profile', 'enderiose');"
    "localStorage.setItem('hm_user', 'smoke');"
    "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
    % (json.dumps(BASE), json.dumps(TOKEN)))


def scene(name, logged_in, actions):
    with sync_playwright() as p:
        b = p.chromium.launch(args=LAUNCH_ARGS)
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        if logged_in:
            ctx.add_init_script(LOGIN_JS)
        ctx.route('**/__app__',
                  lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/__app__', wait_until='load')
        pg.wait_for_timeout(2500)
        actions(pg)
        path = os.path.join(OUT, name + '.png')
        pg.screenshot(path=path)
        b.close()
    print('%-12s %s%s' % (name, path, ('  PAGEERROR: ' + errs[0]) if errs else ''))


def open_first(pg):
    pg.evaluate("() => {const el=document.querySelector('#view-sessions .row'); if(el) el.click();}")
    pg.wait_for_timeout(3000)


scene('1-login', False, lambda pg: None)
scene('2-sessions', True, lambda pg: print('  rows:', pg.evaluate(
    "() => document.querySelectorAll('#view-sessions .row').length")))
scene('3-chat', True, lambda pg: (open_first(pg), print('  msgs:', pg.evaluate(
    "() => document.querySelectorAll('#msg-list .msg').length"))))
scene('4-attach', True, lambda pg: (open_first(pg),
                                    pg.evaluate("() => {const b=document.querySelector('#chat-plus'); if(b) b.click();}"),
                                    pg.wait_for_timeout(700)))


def settings(pg):
    pg.evaluate("() => {const t=document.querySelector('.tab[data-tab=\"settings\"]'); if(t) t.click();}")
    pg.wait_for_timeout(1200)
    print('  client ver:', pg.evaluate("() => {const e=document.querySelector('#set-version'); return e ? e.textContent : 'n/a'}"))


scene('5-settings', True, settings)
print('OK', OUT)
