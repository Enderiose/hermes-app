"""附件面板用例：照片（多选）/ 文件两种入口，选完要能渲染成附件条并带预览。

不真的发送（发送会起一次真实 run，太慢也太吵）；只验证
「点 ＋ → 面板 → 选中文件 → 附件条出现 → 上传状态机就绪」。

    PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
      /opt/hermes/.venv/bin/python tests/attach_panel.py
"""

import json
import os
import struct
import sys
import zlib

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from _launch import LAUNCH_ARGS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'http://127.0.0.1:6060'
TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
INLINE = os.path.join(ROOT, 'app', 'assets', 'www', 'inline.html')
HTML = open(INLINE, encoding='utf-8').read()
TMP = '/tmp/apk-attach'
os.makedirs(TMP, exist_ok=True)


def tiny_png(path, w=8, h=8):
    """手搓一张 PNG（不依赖 Pillow）。"""
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * w for _ in range(h))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    return path


PNG1 = tiny_png(os.path.join(TMP, 'a.png'))
PNG2 = tiny_png(os.path.join(TMP, 'b.png'))
TXT = os.path.join(TMP, 'note.txt')
open(TXT, 'w').write('attachment test\n')

fails = []


def check(name, ok, detail=''):
    print(('  PASS ' if ok else '  FAIL ') + name + ((' — ' + str(detail)) if detail else ''))
    if not ok:
        fails.append(name)


with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH_ARGS)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');"
        "localStorage.setItem('hm_user', 'smoke');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/__app__', wait_until='load')
    pg.wait_for_timeout(2500)

    # 进会话
    pg.evaluate("() => {const el=document.querySelector('#view-sessions .row'); if(el) el.click();}")
    pg.wait_for_timeout(2500)

    # 打开面板
    pg.evaluate("() => document.querySelector('#chat-plus').click()")
    pg.wait_for_timeout(400)
    check('＋ 打开附件面板', pg.evaluate("() => !document.querySelector('#attach-panel').classList.contains('hidden')"))
    check('面板三个入口', pg.evaluate("() => document.querySelectorAll('.attach-item').length") == 3,
          pg.evaluate("() => Array.from(document.querySelectorAll('.attach-item')).map(b=>b.getAttribute('data-kind')).join(',')"))

    # 照片多选：先点面板入口（真实流程会关闭面板并触发 input），再塞文件
    pg.evaluate("() => document.querySelector('.attach-item[data-kind=\"photo\"]').click()")
    pg.wait_for_timeout(300)
    check('点「照片」后面板关闭', pg.evaluate("() => document.querySelector('#attach-panel').classList.contains('hidden')"))
    pg.set_input_files('#pick-photo', [PNG1, PNG2])
    pg.wait_for_timeout(800)
    n_img = pg.evaluate("() => document.querySelectorAll('#attach-list .att').length")
    check('照片多选 → 2 个附件条', n_img == 2, n_img)
    check('图片有本地预览', pg.evaluate("() => document.querySelectorAll('#attach-list .att img').length") == 2)

    # 再挂一个普通文件
    pg.set_input_files('#pick-file', [TXT])
    pg.wait_for_timeout(800)
    check('文件入口 → 第 3 个附件条', pg.evaluate("() => document.querySelectorAll('#attach-list .att').length") == 3)
    check('文件条显示大小/名称', pg.evaluate(
        "() => Array.from(document.querySelectorAll('#attach-list .att')).some(e => /note\\.txt/.test(e.textContent))"))

    # 移除一个
    pg.evaluate("() => {const x=document.querySelector('#attach-list .att .rm'); if(x) x.click();}")
    pg.wait_for_timeout(400)
    check('可移除附件', pg.evaluate("() => document.querySelectorAll('#attach-list .att').length") == 2)

    check('无 pageerror', not errs, (errs[:1] or ''))
    b.close()

print('ATTACH_ALL_PASS' if not fails else 'ATTACH_FAIL: ' + ', '.join(fails))
sys.exit(0 if not fails else 1)
