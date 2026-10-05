"""验证企微 Bot 会话（hermes-history）里的工具调用也被整合。

这类消息的 run_marker 全是 null，靠「用户消息划轮次」的合成键归组。
断言：DOM 里没有散落的单条工具行、分组内的工具条数与服务端原始工具结果行数一致。
"""
import json
import os
from collections import Counter
from urllib import request as urlreq

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-wecom'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()

fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' | ' + str(detail) if detail else ''))
    if not cond:
        fails.append(name)


def api(path):
    req = urlreq.Request(BASE + path, headers={'Authorization': 'Bearer ' + TOKEN,
                                               'X-Hermes-Profile': 'enderiose'})
    with urlreq.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'wecom');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4000)

    page.click('#view-sessions .tab[data-tab="wecom"]')
    page.wait_for_timeout(3000)
    wrows = page.locator('#wecom-list .row')
    check('企微列表有会话', wrows.count() > 0, wrows.count())
    check('企微行不给分类入口（只读）', page.locator('#wecom-list .row .row-more').count() == 0)
    title = wrows.first.inner_text().split('\n')[0]
    print('打开:', title[:40])
    wrows.first.click()
    page.wait_for_timeout(5000)

    st = page.evaluate("""() => {
        const raw = state.msgs.length;
        const toolMsgs = state.msgs.filter(m => m.role === 'tool');
        const groups = [...document.querySelectorAll('#msg-list .tool-run-row')];
        return {
            curHermes: state.curHermes,
            sid: state.cur,
            rawMsgs: raw,
            toolMsgs: toolMsgs.length,
            withMarker: toolMsgs.filter(m => m.runMarker).length,
            withSynth: toolMsgs.filter(m => !m.runMarker && m.synthRun).length,
            synthKeys: [...new Set(toolMsgs.map(m => m.synthRun).filter(Boolean))].length,
            groups: groups.length,
            groupCounts: groups.map(g => parseInt((g.querySelector('.tool-run-count').textContent || '0').split(' ')[0], 10)),
            loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length,
            ungrouped: document.querySelectorAll('#msg-list > .msg.assistant > .msg-line > .tool-row').length,
            titles: [...document.querySelectorAll('#msg-list .tool-run-row .tool-run-names')].slice(0, 5).map(e => e.textContent),
        };
    }""")
    print(json.dumps({k: v for k, v in st.items() if k != 'groupCounts'}, ensure_ascii=False))
    print('每组条数:', st['groupCounts'][:20])

    check('已是企微（hermes-history）会话', st['curHermes'] is True, st['curHermes'])
    check('这类消息确实没有 run_marker（走合成键）', st['withMarker'] == 0 and st['withSynth'] > 0,
          'marker=%s synth=%s' % (st['withMarker'], st['withSynth']))
    check('出现了整合行', st['groups'] > 0, st['groups'])
    check('没有散落的单条工具行', st['loose'] == 0 and st['ungrouped'] == 0,
          'loose=%s ungrouped=%s' % (st['loose'], st['ungrouped']))
    check('整合行覆盖全部工具行', sum(st['groupCounts']) == st['toolMsgs'],
          'sum=%s tools=%s' % (sum(st['groupCounts']), st['toolMsgs']))

    # 对照服务端原始数据：工具结果行数应等于所有分组里的条数之和
    sid = st['sid']
    raw = api('/api/studio/sessions/hermes/%s?profile=enderiose' % sid)
    msgs = (raw.get('session') or {}).get('messages') or []
    results = [m for m in msgs if (m.get('display_role') or m.get('role')) == 'tool' and m.get('tool_name')]
    anns = [m for m in msgs if m.get('tool_calls')]
    print('服务端：结果行 %d，公告行 %d，run_marker 分布 %s' % (
        len(results), len(anns), Counter(repr(m.get('run_marker')) for m in msgs)))
    check('分组条数 == 服务端工具结果行数', sum(st['groupCounts']) == len(results),
          'dom=%s api=%s' % (sum(st['groupCounts']), len(results)))

    # 展开一个分组，确认逐条可见
    page.locator('#msg-list .tool-run-row').first.click()
    page.wait_for_timeout(600)
    expanded = page.evaluate("""() => {
        const rows = [...document.querySelectorAll('#msg-list .tool-run-expand .tool-row')];
        return { n: rows.length, names: rows.map(r => (r.querySelector('.t-name') || {}).textContent) };
    }""")
    check('展开后能看到逐个调用', expanded['n'] == st['groupCounts'][0], expanded)
    page.screenshot(path=OUT + '/01-wecom-grouped.png', full_page=False)
    page.locator('#msg-list .tool-run-row').first.click()
    page.wait_for_timeout(300)

    # 换一个更长的企微会话，确认同样成立
    page.evaluate('closeChat()')
    page.wait_for_timeout(2500)
    page.wait_for_selector('#wecom-list .row', state='visible')
    page.locator('#wecom-list .row').nth(1).click()
    page.wait_for_timeout(6000)
    st2 = page.evaluate("""() => {
        const groups = [...document.querySelectorAll('#msg-list .tool-run-row')];
        const tools = state.msgs.filter(m => m.role === 'tool');
        return {
            sid: state.cur,
            toolMsgs: tools.length,
            groups: groups.length,
            sum: groups.reduce((a, g) => a + parseInt((g.querySelector('.tool-run-count').textContent || '0').split(' ')[0], 10), 0),
            loose: document.querySelectorAll('#msg-list .msg.assistant > .msg-line > .tool-row').length,
            titles: document.getElementById('chat-title').textContent,
            groupCounts: groups.map(g => parseInt((g.querySelector('.tool-run-count').textContent || '0').split(' ')[0], 10)),
        };
    }""")
    print(json.dumps(st2, ensure_ascii=False))
    raw2 = api('/api/studio/sessions/hermes/%s?profile=enderiose' % st2['sid'])
    msgs2 = (raw2.get('session') or {}).get('messages') or []
    results2 = [m for m in msgs2 if (m.get('display_role') or m.get('role')) == 'tool' and m.get('tool_name')]
    check('第二个会话：有整合行且无散落单条', st2['groups'] > 0 and st2['loose'] == 0, st2['groups'])
    check('第二个会话：分组条数 == 服务端结果行数', st2['sum'] == len(results2),
          'dom=%s api=%s' % (st2['sum'], len(results2)))
    check('第二个会话：分了多少轮（不止一组）', st2['groups'] > 1, st2['groups'])
    page.screenshot(path=OUT + '/02-wecom-long.png', full_page=False)

    if errs:
        print('--- 页面错误 ---')
        for e in errs[-6:]:
            print(e)
    browser.close()

print('FAILED: ' + ', '.join(fails) if fails else 'ALL_PASS')
