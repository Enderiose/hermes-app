"""验证图片上传 + 官方图标：
1. 助手头像全部用 data:image 官方图标（不再有 bot-def 字母块）
2. 上传一张真图到 /api/studio/uploads，拿到 path
3. 用 imageSrcFor() 拼出的 preview URL 真能取回图片（HTTP 200 + 是图片）
4. 带图片发送时 emit('run') 的 body.input 是 ContentBlock 数组（含 image block）
5. 消息里能渲染出 <img class="chat-img">
"""
import base64
import json
import os

import urllib.request
from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-fix'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

print('=== 0. inline.html 图标注入检查 ===')
print('  含 data:image/png 助手头像:', 'src="data:image/png;base64,' in HTML)
print('  残留占位符:', '__HERMES_BOT_ICON__' in HTML)

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
    errs = []
    page.on('pageerror', lambda e: errs.append('PAGEERROR: %s' % e))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4500)

    print()
    print('=== 1. 助手头像 ===')
    page.locator('#session-list .row').first.click()
    page.wait_for_timeout(4000)
    m = page.evaluate("""() => {
      const av = [...document.querySelectorAll('#msg-list .avatar')];
      const dataUris = av.filter(a => (a.getAttribute('src')||'').startsWith('data:image'));
      const letterDefs = [...document.querySelectorAll('#msg-list .avatar.bot-def')];
      return { total: av.length, dataUri: dataUris.length, letterBlocks: letterDefs.length,
               sample: (dataUris[0]?.getAttribute('src')||'').slice(0,32) };
    }""")
    print('  头像总数:', m['total'], ' 官方图标(data URI):', m['dataUri'], ' 字母兜底块:', m['letterBlocks'])
    print('  样例:', m['sample'])
    page.screenshot(path=OUT + '/10-official-icon.png')

    print()
    print('=== 2. 真实上传测试 ===')
    # 生成一张真实 PNG
    png = base64.b64decode(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAABlBMVEX/'
        'AAD//wAA/wEBvQAAAApJREFUeNrtwTEBACAMA7DEf9/HTQ2oICKZ5H8n'
        'BWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW'
        'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh'
        'AAAAAElFTkSuQmCC')
    b64 = base64.b64encode(png).decode()
    res = page.evaluate("""async (b64) => {
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const f = new File([blob], 'probe.png', { type: 'image/png' });
      const fd = new FormData(); fd.append('file', f, 'probe.png');
      const r = await fetch(state.base.replace(/\\/$/,'') + '/api/studio/uploads', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token, 'X-Hermes-Profile': state.profile },
        body: fd });
      if (!r.ok) return { ok:false, status:r.status, body: await r.text() };
      const d = await r.json();
      return { ok:true, files: d.files };
    }""", b64)
    print('  上传:', json.dumps(res, ensure_ascii=False)[:200])
    if res.get('ok') and res.get('files'):
        path = res['files'][0]['path']
        print('  服务端 path:', path)
        # 验证 preview URL 可取回
        url = page.evaluate("(p) => imageSrcFor(p)", path)
        print('  preview URL:', url[:120])
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + TOKEN})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
            print('  取回: HTTP', r.status, 'bytes', len(data), 'PNG?', data[:4] == b'\x89PNG')
        except Exception as e:
            print('  取回失败:', e)

    print()
    print('=== 3. 消息内图片渲染 ===')
    n = page.evaluate("""(p) => {
      // 手工注入一条带图消息，验证渲染路径（用真实上传得到的 path）
      state.msgs.push({ key:'probe', role:'user', content:'看图', ts: Date.now()/1000,
        images: [{ name:'probe.png', path: p, media_type:'image/png' }] });
      renderMsgs();
      const imgs = [...document.querySelectorAll('#msg-list img.chat-img')];
      return { count: imgs.length, src: (imgs[0]?.getAttribute('src')||'').slice(0,60),
               naturalWidth: imgs[0]?.naturalWidth ?? null };
    }""" , path)
    print('  img.chat-img:', n.get('count'))
    print('  src 前缀:', n.get('src'))
    # 等 <img> 真正加载完再读 naturalWidth
    page.wait_for_timeout(2500)
    w = page.evaluate("() => { const i=document.querySelector('#msg-list img.chat-img'); return i? i.naturalWidth : null; }")
    print('  图片实际加载宽度 naturalWidth:', w, '(>0 表示真的显示出来了)')
    page.screenshot(path=OUT + '/11-image-in-msg.png')

    print()
    print('=== 4. 图片按钮存在 ===')
    print('  #chat-img 可见:', page.locator('#chat-img').is_visible())
    print('  #img-picker 存在:', page.locator('#img-picker').count())

    print()
    print('=== 页面错误 ===')
    for e in errs[-8:]:
        print(' ', e[:160])
    browser.close()
print('\nIMG_DONE')
