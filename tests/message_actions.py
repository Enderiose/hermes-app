"""消息操作用例（v1.0.1 新增）：长按菜单的 复制 / 引用 / 朗读 / Fork。

不依赖真机长按手势（Playwright 里不可靠），直接调 openMessageActions()
——它内部走的是同一条 actionSheet，菜单项与真实长按完全一致。

    PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
      /opt/hermes/.venv/bin/python tests/message_actions.py
"""

import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from _launch import LAUNCH_ARGS  # noqa: E402

BASE = 'http://127.0.0.1:6060'
TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
HTML = open(INLINE, encoding='utf-8').read()

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
    pg.evaluate("() => document.querySelector('#view-sessions .row').click()")
    pg.wait_for_timeout(3500)

    # 菜单项：助手消息应有 复制 / 引用 / 朗读 / Fork
    rows = pg.evaluate("""() => {
      const m = state.msgs.filter(x => x.role === 'assistant' && String(x.content||'').trim()).pop();
      openMessageActions(m.key);
      const list = document.getElementById('menu-list');
      return { key: m.key, labels: [...list.querySelectorAll('.menu-item .menu-label')].map(e => e.textContent) };
    }""")
    print('  助手菜单:', rows['labels'])
    for want in ('复制', '引用', '朗读', 'Fork 当前会话'):
        check('助手菜单含「%s」' % want, want in rows['labels'])

    # 用户消息：只有 复制 / 引用（不给朗读与 Fork）
    urows = pg.evaluate("""() => {
      document.getElementById('menu-cancel').click();
      const m = state.msgs.filter(x => x.role === 'user').pop();
      openMessageActions(m.key);
      return [...document.querySelectorAll('#menu-list .menu-item .menu-label')].map(e => e.textContent);
    }""")
    print('  用户菜单:', urows)
    check('用户菜单只有 复制/引用', sorted(urows) == sorted(['复制', '引用']), urows)

    # 引用：点「引用」→ 出现引用条，发送时拼成 quoted_message 块
    q = pg.evaluate("""() => {
      document.getElementById('menu-cancel').click();
      const m = state.msgs.filter(x => x.role === 'assistant' && String(x.content||'').trim()).pop();
      setQuote(m);
      const bar = document.getElementById('quote-bar');
      const shown = !bar.classList.contains('hidden');
      const text = (document.getElementById('quote-text') || {}).textContent || '';
      const block = formatQuoted(state.quote, '我的回复');
      clearQuote();
      return { shown, text: text.slice(0, 20), hasBlock: block.includes('<quoted_message'),
               barHiddenAfterClear: document.getElementById('quote-bar').classList.contains('hidden') };
    }""")
    check('引用后出现引用条', q['shown'], q['text'])
    check('引用拼成 quoted_message 块', q['hasBlock'])
    check('清除引用后引用条隐藏', q['barHiddenAfterClear'])

    # 朗读：必须有 speechSynthesis 才有按钮；调用不应抛错
    sp = pg.evaluate("""() => {
      const has = 'speechSynthesis' in window;
      const m = state.msgs.filter(x => x.role === 'assistant' && String(x.content||'').trim()).pop();
      let threw = null;
      try { speakText('测试朗读一句话', m.key); } catch (e) { threw = String(e); }
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
      return { has, threw };
    }""")
    check('朗读调用不抛错', sp['threw'] is None, sp['threw'] or 'speechSynthesis=%s' % sp['has'])

    # 复制：WebView 外（Playwright）走 navigator.clipboard 或降级，不应抛错
    cp = pg.evaluate("""() => {
      let threw = null;
      try { copyText('复制测试'); } catch (e) { threw = String(e); }
      return { threw };
    }""")
    check('复制调用不抛错', cp['threw'] is None, cp['threw'] or '')

    check('无 pageerror', not errs, (errs[:1] or ''))
    b.close()

print('ACTIONS_ALL_PASS' if not fails else 'ACTIONS_FAIL: ' + ', '.join(fails))
sys.exit(0 if not fails else 1)
