"""验证会话分类：分类 CRUD、会话归属、新建会话时选分类。

只动测试自建的数据：一个临时分类 + 一个临时会话（跑完都删掉），不碰用户已有会话。
"""
import json
import os
import time
from urllib import request as urlreq

from playwright.sync_api import sync_playwright

TOKEN = open('/home/agent/.hermes-web-ui/profiles/enderiose/.model-run-token').read().strip()
BASE = 'http://127.0.0.1:6060'
INLINE = '/home/agent/.hermes/hermes-app/app/assets/www/inline.html'
OUT = '/tmp/apk-cats'
os.makedirs(OUT, exist_ok=True)
HTML = open(INLINE, encoding='utf-8').read()
CAT = 'APK测试分类%s' % time.strftime('%H%M%S')
CAT2 = CAT + '改'

fails = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' | ' + str(detail) if detail else ''))
    if not cond:
        fails.append(name)


def api(method, path, body=None):
    req = urlreq.Request(BASE + path, method=method,
                         data=json.dumps(body).encode() if body is not None else None,
                         headers={'Authorization': 'Bearer ' + TOKEN,
                                  'Content-Type': 'application/json',
                                  'X-Hermes-Profile': 'enderiose'})
    with urlreq.urlopen(req, timeout=20) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def cats():
    return api('GET', '/api/studio/session-categories?profile=enderiose')['categories']


def cat_id(name):
    for c in cats():
        if c['name'] == name:
            return c['id']
    return None


def session_row(sid):
    lst = api('GET', '/api/studio/sessions?profile=enderiose&limit=200').get('sessions') or []
    for s in lst:
        if s['id'] == sid:
            return s
    return None


def sheet_items(page):
    return page.eval_on_selector_all('#menu-list .menu-item', 'els => els.map(e => e.innerText)') \
        if page.locator('#menu-sheet').is_visible() else []


def click_sheet(page, contains):
    page.locator('#menu-list .menu-item', has_text=contains).first.click()
    page.wait_for_timeout(400)


sid = None
created = None
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--disable-features=LocalNetworkAccessChecks'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.add_init_script(
        "localStorage.setItem('hm_base', %s);localStorage.setItem('hm_token', %s);"
        "localStorage.setItem('hm_profile', 'enderiose');localStorage.setItem('hm_user', 'cattest');"
        "localStorage.setItem('hm_profiles', JSON.stringify(['enderiose']));"
        % (json.dumps(BASE), json.dumps(TOKEN)))
    ctx.route('**/__app__', lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML))
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/__app__')
    page.wait_for_timeout(4500)
    check('socket 已连接', bool(page.evaluate("!!(state.socket && state.socket.connected)")))
    check('会话行有「⋯」入口', page.locator('#session-list .row .row-more').count() > 0,
          page.locator('#session-list .row').count())
    check('会话页有分类管理入口', page.locator('#btn-cats').is_visible())

    # ---- 1. 新建分类（🏷 → ＋新建分类 → 输入名字） ----
    page.click('#btn-cats')
    page.wait_for_timeout(600)
    check('分类管理面板打开', page.locator('#menu-sheet').is_visible(), sheet_items(page)[:4])
    click_sheet(page, '新建分类')
    check('弹出名称输入框', page.locator('#modal').is_visible() and page.locator('#modal-input').count() == 1)
    page.fill('#modal-input', CAT)
    page.screenshot(path=OUT + '/01-create-category.png')
    page.click('#modal-ok')
    page.wait_for_timeout(1200)
    cid = cat_id(CAT)
    check('分类已建到服务端', cid is not None, CAT)
    check('本地分类列表已更新', CAT in page.evaluate("state.categories.map(c => c.name)"))

    # ---- 2. 新建会话时选分类（聊天页「分类」按钮） ----
    page.click('#fab-new')
    page.wait_for_timeout(900)
    sid = page.evaluate('state.cur')
    print('测试会话:', sid)
    check('聊天页有分类按钮', page.locator('#chat-cat').is_visible(),
          page.locator('#chat-cat').inner_text())
    page.click('#chat-cat')
    page.wait_for_timeout(900)
    check('分类 sheet 打开', page.locator('#chat-cat-sheet').is_visible())
    items = page.eval_on_selector_all('#cat-list .cat-item', 'els => els.map(e => e.innerText)')
    check('分类 sheet 列出新分类', any(CAT in t for t in items), items[:6])
    check('默认选中「未分类」', '未分类' in page.eval_on_selector('#cat-list .cat-item.active', 'e => e.innerText'))
    page.locator('#cat-list .cat-item', has_text=CAT).first.click()
    page.wait_for_timeout(700)
    check('待定分类已记住', page.evaluate('state.newSessionCategoryId') == cid,
          page.evaluate('state.newSessionCategoryId'))
    check('标题按钮显示所选分类', CAT in page.locator('#chat-cat').inner_text(),
          page.locator('#chat-cat').inner_text())
    page.screenshot(path=OUT + '/02-new-session-category.png')

    # ---- 3. 发首条消息 → 会话落库时带上分类 ----
    page.fill('#chat-input', '只回复两个字：完成')
    page.click('#chat-send')
    ok = False
    for _ in range(40):
        page.wait_for_timeout(1000)
        row = session_row(sid)
        if row and row.get('category_id'):
            ok = (row['category_id'] == cid)
            break
    check('新会话落库即带所选分类', ok, session_row(sid))

    # 等这一轮跑完再操作列表
    for _ in range(40):
        page.wait_for_timeout(1000)
        if not page.evaluate("!!document.querySelector('#msg-list .bubble.caret')"):
            break

    # ---- 4. 行菜单改归属（⋯ → 移动到分类 → 未分类） ----
    page.click('#chat-back')
    page.wait_for_timeout(2500)
    row = page.locator('#session-list .row[data-id="%s"]' % sid)
    # 「最近」是快捷入口，同一会话会同时出现在「最近」和真实分类里（与 web 一致）
    check('列表里能找到测试会话', row.count() >= 1, row.count())
    check('测试分类出现分组头', page.locator('#session-list .group-name', has_text=CAT).count() == 1)
    row.first.locator('.row-more').click()
    page.wait_for_timeout(700)
    check('行菜单打开', page.locator('#menu-sheet').is_visible(), sheet_items(page))
    click_sheet(page, '移动到分类')
    check('分类选择表打开', any('未分类' in t for t in sheet_items(page)), sheet_items(page)[:6])
    click_sheet(page, '未分类')
    page.wait_for_timeout(1200)
    check('已移到未分类（服务端）', (session_row(sid) or {}).get('category_id') in (None, 0), session_row(sid))
    check('分组头消失', page.locator('#session-list .group-name', has_text=CAT).count() == 0)
    page.screenshot(path=OUT + '/03-moved-none.png')

    # 再移回测试分类
    page.locator('#session-list .row[data-id="%s"] .row-more' % sid).first.click()
    page.wait_for_timeout(600)
    click_sheet(page, '移动到分类')
    page.wait_for_timeout(300)
    page.locator('#menu-list .menu-item', has_text=CAT).first.click()
    page.wait_for_timeout(1200)
    check('更到测试分类（服务端）', (session_row(sid) or {}).get('category_id') == cid, session_row(sid))
    check('分组头回来了', page.locator('#session-list .group-name', has_text=CAT).count() == 1)

    # ---- 5. 分组头 ⋯ → 重命名 ----
    head = page.locator('#session-list .group-head', has_text=CAT).first
    head.locator('.head-more').click()
    page.wait_for_timeout(700)
    menu = sheet_items(page)
    check('分组头菜单打开', len(menu) == 2 and menu[0] == '重命名' and menu[1].startswith('删除分类'), menu)
    click_sheet(page, '重命名')
    check('弹出重命名输入框（带旧名）', page.locator('#modal-input').input_value() == CAT,
          page.locator('#modal-input').input_value())
    page.fill('#modal-input', CAT2)
    page.click('#modal-ok')
    page.wait_for_timeout(1200)
    check('服务端已改名', cat_id(CAT2) is not None and cat_id(CAT) is None, cats())
    check('分组头显示新名', page.locator('#session-list .group-name', has_text=CAT2).count() == 1)
    page.screenshot(path=OUT + '/04-renamed.png')

    # ---- 6. 分组头 ⋯ → 删除（确认弹窗） ----
    page.locator('#session-list .group-head', has_text=CAT2).first.locator('.head-more').click()
    page.wait_for_timeout(600)
    click_sheet(page, '删除分类')
    check('删除二次确认', page.locator('#modal').is_visible()
          and '删除分类' in page.locator('#modal-title').inner_text(),
          page.locator('#modal-title').inner_text())
    page.click('#modal-ok')
    page.wait_for_timeout(1800)
    check('服务端分类已删除', cat_id(CAT2) is None, cats())
    check('分类下的会话回到未分类', (session_row(sid) or {}).get('category_id') in (None, 0), session_row(sid))
    check('分组头消失', page.locator('#session-list .group-name', has_text=CAT2).count() == 0)
    page.screenshot(path=OUT + '/05-deleted.png')

    if errs:
        print('--- 页面错误 ---')
        for e in errs[-6:]:
            print(e)
    browser.close()

# ---- 清理测试会话（分类已在上面的流程里删掉） ----
if sid:
    try:
        api('DELETE', '/api/studio/sessions/%s?profile=enderiose' % sid)
        check('测试会话已删除', session_row(sid) is None)
    except Exception as e:
        check('测试会话已删除', False, str(e))
leftover = [c for c in cats() if c['name'].startswith('APK测试分类')]
check('无残留测试分类', not leftover, leftover)

print('FAILED: ' + ', '.join(fails) if fails else 'ALL_PASS')
