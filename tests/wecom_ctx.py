"""企微会话的上下文用量条（回归：曾显示成 session 累计 = 几百万）。

背景：企微会话是 hermes-history 会话 —— 不走 socket `resumed`、
`/api/studio/sessions/:id/usage` 也查不到（studio 库不记录 gateway 侧用量）。
老实现退路拿 `GET /api/studio/sessions/hermes/:id` 的 `input_tokens+output_tokens`，
那是**每次 API 调用的 prompt 累加**（同一段历史被重复计 N 次），长会话显示成
1.6M~7M，看着像一直在爆上下文；真实最后一次 prompt 只有一百多 k。

现实现：按消息字数估算当前上下文（`estimateContextTokens`），带 ≈ 标记。
真值取自 Hermes state.db 的 `sessions.model_config._usage_anchor.prompt_tokens`
（provider 回报的最后一次 prompt），用来卡误差。

断言（每个会话）：
  1. 文本里带 ≈（标明是估算）；
  2. 估算值与真值偏差 ≤35%；
  3. 估算值明显小于累计 in+out（长会话至少小 2 倍，防止退回旧口径）。

用法：/opt/hermes/.venv/bin/python tests/wecom_ctx.py
"""
import json
import os
import re
import sqlite3
import sys
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../scripts'))
from _launch import LAUNCH_ARGS  # noqa: E402
TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
PROFILE = 'enderiose'
STATE_DB = '/home/agent/.hermes/profiles/enderiose/state.db'
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


def anchor_tokens(session_id):
    """真值：Hermes 落盘的 usage anchor（最后一次 provider 回报的 prompt）。"""
    db = sqlite3.connect('file:%s?mode=ro' % STATE_DB, uri=True)
    try:
        row = db.execute('SELECT model_config FROM sessions WHERE id=?',
                         (session_id,)).fetchone()
    finally:
        db.close()
    if not row or not row[0]:
        return 0
    try:
        return int((json.loads(row[0]).get('_usage_anchor') or {}).get('prompt_tokens') or 0)
    except (ValueError, TypeError):
        return 0


def shown_tokens(text):
    """从 '≈143.2k' / '≈1.2M' 里取出数字。"""
    m = re.search(r'≈\s*([\d.]+)\s*([kM]?)', text or '')
    if not m:
        return None
    v = float(m.group(1))
    return int(v * {'': 1, 'k': 1000, 'M': 1000000}[m.group(2)])


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
    browser = p.chromium.launch(args=LAUNCH_ARGS)
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
        sess = api('/api/studio/sessions/hermes/%s?profile=%s' % (sid, PROFILE))['session']
        cumulative = int(sess.get('input_tokens') or 0) + int(sess.get('output_tokens') or 0)
        truth = anchor_tokens(sid)
        shown = shown_tokens(info['text'])

        print('\n[%s] %s' % (info['title'], sid))
        print('  上下文条:', info['text'])
        print('  估算: %s / 真值(anchor): %s / 累计 in+out: %s'
              % (shown, truth, cumulative))

        if shown is None:
            print('  ❌ 文本里没有 ≈ 估算值')
            failures.append(sid)
        elif truth > 0 and not (truth * 0.65 <= shown <= truth * 1.35):
            print('  ❌ 与真值偏差 >35%')
            failures.append(sid)
        elif cumulative > 0 and shown * 2 >= cumulative:
            print('  ❌ 仍等于/接近累计口径（应远小于 in+out）')
            failures.append(sid)
        else:
            print('  ✅ 估算合理')
        page.screenshot(path=OUT + ('/wecom-ctx-%d.png' % i))
        page.click('#chat-back')
        page.wait_for_timeout(1200)

    print('\n页面错误:', errs[-5:] if errs else '无')
    browser.close()

print('\n结果:', 'FAIL ' + ','.join(failures) if failures else 'PASS')
print('WECOM_CTX_DONE')
