"""验证三项修复：
1. 头像 —— 聊天页每条用户消息旁渲染 <img class="avatar" src="data:image/...">
2. 会话分组 —— 列表出现 .group-head，且每个会话归属正确的 category
3. 会话内长文不溢出 —— 实测每条消息的 right 边界 <= 屏幕宽度（390），且 .msgs 无横向滚动
"""
import json
import os

from playwright.sync_api import sync_playwright

TOKEN_FILE = '/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token'
TOKEN = open(TOKEN_FILE).read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-fix'
os.makedirs(OUT, exist_ok=True)

HTML = open(INLINE, encoding='utf-8').read()

# 用 NLP 会话构造一条超长无换行消息 / 代码块 / 长 URL 注入后测量
INJECT = None  # 由命令行参数决定是否注入

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);"
        "localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');"
        "localStorage.setItem('hm_user', 'Enderiose');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN))
    )
    ctx.route('**/__app__', lambda route: route.fulfill(
        status=200, content_type='text/html; charset=utf-8', body=HTML))

    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append('PAGEERROR: %s' % e))
    page.on('console', lambda m: errs.append('CONSOLE %s: %s' % (m.type, m.text))
            if m.type == 'error' and 'ERR_BLOCKED_BY_LOCAL_NETWORK' not in m.text else None)

    page.goto(BASE + '/__app__')
    page.wait_for_timeout(5000)

    heads = page.locator('#session-list .group-head')
    print('=== 2. 会话分组 ===')
    print('分组数:', heads.count())
    for i in range(heads.count()):
        print('  ', heads.nth(i).inner_text().replace('\n', ' '))
    rows = page.locator('#session-list .row')
    print('会话行数:', rows.count())
    page.screenshot(path=OUT + '/01-sessions-grouped.png')

    print()
    print('=== 1. 头像 ===')
    # 打开一个有多条消息的会话
    rows.first.click()
    page.wait_for_timeout(4500)
    avatars = page.locator('#msg-list .avatar')
    print('头像元素数:', avatars.count())
    if avatars.count():
        first = avatars.first
        print('  首头像 tag:', first.evaluate('el => el.tagName'))
        print('  首头像 src 前缀:', (first.get_attribute('src') or '')[:40])
        box = first.bounding_box()
        print('  首头像尺寸:', box)
    page.screenshot(path=OUT + '/02-chat-avatars.png')

    print()
    print('=== 3. 溢出检测（视口 390px）===')
    m = page.evaluate("""() => {
      const msgs = document.getElementById('msg-list');
      const out = {
        scrollW: msgs.scrollWidth, clientW: msgs.clientWidth,
        docScrollW: document.documentElement.scrollWidth,
        bodyScrollW: document.body.scrollWidth,
        worst: null, overflowing: []
      };
      document.querySelectorAll('#msg-list .bubble, #msg-list .msg-line, #msg-list .msg').forEach(el => {
        const r = el.getBoundingClientRect();
        const rec = { cls: el.className, right: Math.round(r.right), width: Math.round(r.width) };
        if (r.right > 391 || r.width > 391) out.overflowing.push(rec);
        if (!out.worst || r.right > out.worst.right) out.worst = rec;
      });
      return out;
    }""")
    print('  #msg-list scrollWidth:', m['scrollW'], ' clientWidth:', m['clientW'])
    print('  document scrollWidth :', m['docScrollW'], ' body scrollWidth:', m['bodyScrollW'])
    print('  横向溢出元素数:', len(m['overflowing']))
    print('  最宽元素:', m['worst'])
    for o in m['overflowing'][:6]:
        print('    溢出:', o)

    # 注入极端长文（无换行），再测
    print()
    print('=== 3b. 注入无换行长串 / 代码块 / 长URL 后再测 ===')
    page.evaluate("""() => {
      const long = 'A'.repeat(400) + ' ' + 'B'.repeat(300);
      const url = 'https://example.com/' + 'segment-'.repeat(60) + 'end';
      const code = 'const x = ' + '1+'.repeat(200) + '1;';
      const md = [
        '长串测试: ' + long,
        '',
        '长URL: ' + url,
        '',
        '```js',
        code,
        '```',
        '',
        '| 列1 | 列2 | 列3 |',
        '| --- | --- | --- |',
        '| ' + '超长单元格内容'.repeat(12) + ' | b | c |'
      ].join('\\n');
      window.__t = md;
    }""")
    # 直接用页面内部的 md + wrapOverflow 渲染到当前聊天区
    page.evaluate("""() => {
      const msgs = document.getElementById('msg-list');
      const html = wrapOverflow(md(window.__t));
      const d = document.createElement('div');
      d.className = 'msg assistant';
      d.innerHTML = '<div class="msg-line">' + botAvatarHtml() + '<div class="bubble">' + html + '</div></div>';
      msgs.appendChild(d);
    }""")
    page.wait_for_timeout(800)
    m2 = page.evaluate("""() => {
      const out = { scrollW: document.getElementById('msg-list').scrollWidth,
                    clientW: document.getElementById('msg-list').clientWidth,
                    docScrollW: document.documentElement.scrollWidth,
                    overflowing: [] };
      document.querySelectorAll('#msg-list .bubble, #msg-list .msg-line, #msg-list .msg').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > 391 || r.width > 391)
          out.overflowing.push({ cls: el.className, right: Math.round(r.right), width: Math.round(r.width) });
      });
      const pre = document.querySelector('#msg-list .code-wrap');
      out.codeWrap = pre ? Math.round(pre.getBoundingClientRect().right) : null;
      out.codeScrolls = pre ? (pre.scrollWidth > pre.clientWidth) : null;
      return out;
    }""")
    print('  #msg-list scrollWidth:', m2['scrollW'], ' clientWidth:', m2['clientW'])
    print('  document scrollWidth :', m2['docScrollW'])
    print('  横向溢出元素数:', len(m2['overflowing']))
    for o in m2['overflowing'][:6]:
        print('    溢出:', o)
    print('  代码块容器 right:', m2['codeWrap'], ' 内部横向滚动:', m2['codeScrolls'])
    page.screenshot(path=OUT + '/03-overflow-test.png', full_page=False)

    print()
    print('=== 页面错误 ===')
    for e in errs[-10:]:
        print(' ', e[:160])
    browser.close()
print('VERIFY_DONE')
