/* Hermes 移动版 — Ekko Studio / Hermes Web UI 混合客户端
 * 协议参照 Web 版：REST /api/studio/** + Socket.IO /chat-run
 */
'use strict';

/* ============================== 状态 ============================== */
const $ = (id) => document.getElementById(id);

/** 服务器地址的真源：原生端 SharedPreferences（页面以该 origin 加载，socket.io 才认）。 */
function nativeBase() {
  try {
    if (window.Android && window.Android.getBase) return window.Android.getBase();
  } catch (e) {}
  return '';
}
function setNativeBase(url) {
  try {
    if (window.Android && window.Android.setBase) { window.Android.setBase(url); return true; }
  } catch (e) {}
  return false;
}

const state = {
  base: nativeBase() || localStorage.getItem('hm_base') || '__DEFAULT_BASE_URL__',
  token: localStorage.getItem('hm_token') || '',
  user: localStorage.getItem('hm_user') || '',
  profile: localStorage.getItem('hm_profile') || 'enderiose',
  profiles: safeJson(localStorage.getItem('hm_profiles'), []),
  /** 连过的自建 Studio：[{base,name,version,machineId,lastUser,lastUsed}] */
  studios: safeJson(localStorage.getItem('hm_studios'), []),
  /** 当前 Studio 探测结果（GET /api/devices/link-info） */
  studio: { version: '', machineId: '', checked: false },
  /** 外观：auto | dark | light */
  theme: localStorage.getItem('hm_theme') || 'auto',
  view: 'login',
  sessions: [],
  wecom: [],
  cur: null,          // 当前打开的会话 id
  curHermes: false,   // 是否 hermes-history 会话（企微等）
  curTitle: '',
  curModel: '',
  curProvider: '',
  msgs: [],           // {key, role, content, reasoning, tool, ts}
  cards: [],          // approval / clarify 交互卡
  working: {},        // sid -> true
  socket: null,
  models: [],
  chosenModel: null,  // {provider, model}
  streaming: null,    // {key, sid, text, reasoning, el}
  searchMode: false,
  avatar: '',         // 当前账号头像 dataUrl（type=image）
  avatarSeed: '',     // type=default 时的 seed
  categories: [],     // [{id, name}]
  collapsed: {},      // categoryId -> true 分组折叠
  // 上下文上限覆盖：'' = 走服务端 context-length；否则用户手选的上限（字节）。
  // 在「262144 ↔ 1048576」之间切换，存在 localStorage 持久化。
  ctxLimitOverride: localStorage.getItem('hm_ctx_limit') || '',
  /** 当前会话的排队消息（followed 队列），[ {id, role, content, ts, queued:true} ] */
  queued: [],
  /** 思考级别（reasoning effort），'' = 用配置默认 */
  reasoningEffort: '',
  /** 服务端给的真实上下文占用（contextTokens），比 REST 累计用量准 */
  contextTokens: 0,
  /**
   * 企微/hermes-history 会话的用量退路：`/api/studio/sessions/hermes/:id`
   * 返回的 input_tokens+output_tokens（Hermes state.db 的会话累计，web 版同口径）。
   * 这类会话没有 socket 状态，服务端 /usage 也查不到（studio 库只记自己跑的 run）。
   */
  hermesUsage: { input: 0, output: 0 },
  /** 正在插入中的排队消息 id（服务端 run.queue_insertion.updated 推来） */
  queueInsertingId: null,
  /** 展开的工具轮次：runMarker -> true */
  expandedRuns: {},
  /** 进行中的思考条是否展开看全文（默认收起 = 只占一行） */
  expandedReasoning: false,
  /** 新建会话时选好的分类 id（首个 run 随 category_id 带上，服务端 createSession 落库） */
  newSessionCategoryId: null,
  /**
   * 当前运行的归组键，live 工具行用它当 runMarker。
   * socket 的 tool.* 事件只带 run_id（bridge 的 run id），而历史消息里的 run_marker
   * 是服务端另生成的 `cli_run_*`/`cli_resume_*`。中途打开会话时用历史里最新的
   * run_marker 顶上，增量工具条目就并进已在屏的那一组，而不是另起一组。
   */
  activeRunId: '',
  /** 历史里最新的 run_marker（对齐 live 归组键用） */
  lastHistoryRun: '',
  /** 最近一次收到 socket 事件的时间（看门狗判断事件是否静默丢失） */
  lastEventAt: 0,
  /** 任务计划快照（plan.updated），与当前会话绑定 */
  plan: null,
  /** 工作台子页状态：{key, data, loading} */
  wb: { key: '', data: null, loading: false },
};

/** 上下文上限的可选档位（与本地约定一致）。 */
const CONTEXT_LIMIT_CHOICES = [262144, 1048576];

function safeJson(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ============================== API ============================== */

/** 请求超时（毫秒）。WebView 里 fetch 被系统/厂商 ROM 静默吞掉时不会 reject，
 *  只表现为「按钮点了没反应」，必须自己加超时才能把这种静默失败变成一句错误。 */
const API_TIMEOUT_MS = 15000;

/** 带超时的 fetch。超时/网络错误都转成可读的 Error，绝不静默。 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = API_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const base = (state.base || '').replace(/\/$/, '');
      throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒无响应）→ ' + base + '。请确认手机能访问该地址、端口没被防火墙挡住');
    }
    throw new Error('网络请求失败：' + ((e && e.message) || e) + '（当前地址 ' + (state.base || '').replace(/\/$/, '') + '）');
  } finally {
    clearTimeout(timer);
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (state.profile && !opts.noProfileHeader) headers['X-Hermes-Profile'] = state.profile;
  const res = await fetchWithTimeout(state.base.replace(/\/$/, '') + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    logout(true);
    throw new Error('登录已过期，请重新登录');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ============================== Studio（自建服务端） ============================== */

/** 本客户端要求的最低 Studio（hermes-web-ui）版本。低于此版本协议字段不完整。 */
const MIN_STUDIO_VERSION = '0.7.13';

/** 版本比较：a>b 返回 1，a<b 返回 -1，相等 0；无法解析返回 null。 */
function cmpVersion(a, b) {
  const parse = (v) => {
    const m = String(v || '').trim().match(/^[vV]?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** 版本是否满足最低要求；拿不到版本时按「未知但不阻断」处理。 */
function studioVersionOk(v) {
  if (!v) return true;
  const c = cmpVersion(v, MIN_STUDIO_VERSION);
  return c == null ? true : c >= 0;
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 探测 Studio 版本/机器信息。
 * 端点来自逆向（Ekko App 用同一个）：GET /api/devices/link-info → { hermes_web_ui_version }
 * 该端点在某些老版本上可能 404/401 —— 拿不到就标记为未知，不阻断使用。
 */
async function probeStudio() {
  try {
    const info = await api('/api/devices/link-info', { noProfileHeader: true });
    state.studio = {
      version: String((info && info.hermes_web_ui_version) || '').trim(),
      machineId: String((info && (info.machine_id || info.machineId || info.machine)) || '').trim(),
      checked: true,
    };
  } catch (e) {
    state.studio = { version: state.studio.version || '', machineId: state.studio.machineId || '', checked: false };
  }
  rememberStudio();
  renderStudioList();
  renderSettings();
  return state.studio;
}

/** 把当前 base/版本写回「连过的 Studio」列表（最多 8 条）。 */
function rememberStudio() {
  const base = normalizeBase(state.base);
  if (!base || !/^https?:\/\//i.test(base)) return;
  const list = (state.studios || []).filter((s) => normalizeBase(s.base) !== base);
  list.unshift({
    base: base,
    version: state.studio.version || '',
    machineId: state.studio.machineId || '',
    lastUser: state.user || '',
    lastUsed: Date.now(),
  });
  state.studios = list.slice(0, 8);
  try { localStorage.setItem('hm_studios', JSON.stringify(state.studios)); } catch (e) {}
}

function forgetStudio(base) {
  const b = normalizeBase(base);
  state.studios = (state.studios || []).filter((s) => normalizeBase(s.base) !== b);
  try { localStorage.setItem('hm_studios', JSON.stringify(state.studios)); } catch (e) {}
  renderStudioList();
}

/** 登录页的「连过的 Studio」卡片。点一下填入地址（切 origin 需重新登录）。 */
function renderStudioList() {
  const box = $('studio-list');
  if (!box) return;
  const cur = normalizeBase(state.base);
  const list = (state.studios || []).slice(0, 4);
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((s, i) => {
    const active = normalizeBase(s.base) === cur;
    const ver = s.version ? ('v' + s.version) : '版本未知';
    return '<button class="studio-card' + (active ? ' active' : '') + '" data-i="' + i + '">' +
      '<span class="sc-main">' +
        '<span class="sc-base">' + esc(s.base.replace(/^https?:\/\//, '')) + '</span>' +
        '<span class="sc-meta">' + esc(ver) + (s.lastUser ? ' · ' + esc(s.lastUser) : '') + '</span>' +
      '</span>' +
      (active ? '<span class="sc-badge">当前</span>' : '<span class="sc-go">连接</span>') +
    '</button>';
  }).join('');
  box.querySelectorAll('.studio-card').forEach((b) => {
    b.addEventListener('click', () => {
      const s = list[Number(b.getAttribute('data-i'))];
      if (!s) return;
      $('login-base').value = s.base;
      if (s.lastUser) $('login-user').value = s.lastUser;
      if (normalizeBase(s.base) !== normalizeBase(nativeBase())) {
        toast('将切换到 ' + s.base + '，登录后页面会重载');
      }
      try { $('login-pass').focus(); } catch (e) {}
    });
  });
}

/* ============================== 外观 ============================== */

function applyTheme() {
  const t = ['auto', 'dark', 'light'].includes(state.theme) ? state.theme : 'auto';
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('#theme-seg .seg-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-theme') === t);
  });
}

function setTheme(t) {
  state.theme = t;
  try { localStorage.setItem('hm_theme', t); } catch (e) {}
  applyTheme();
}

/* ============================== Markdown-lite ============================== */
function md(src) {
  if (src == null) return '';
  let s = String(src);

  // 代码块先抽出，避免内部被处理
  const blocks = [];
  s = s.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });

  s = esc(s);

  // 图片 / 链接
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 行内样式
  s = s.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 行 -> 块
  const lines = s.split('\n');
  const out = [];
  let list = null;   // 'ul' | 'ol'
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
  };
  const closeList = () => {
    if (list) { out.push('</' + list + '>'); list = null; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      flushPara(); closeList();
      const lv = hm[1].length;
      out.push('<h' + lv + '>' + hm[2] + '</h' + lv + '>');
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }
    const qm = line.match(/^&gt;\s?(.*)$/);
    if (qm) { flushPara(); closeList(); out.push('<blockquote>' + qm[1] + '</blockquote>'); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push('<' + kind + '>'); list = kind; }
      out.push('<li>' + (ul ? ul[1] : ol[1]) + '</li>');
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara(); closeList();

  s = out.join('\n');
  // 还原代码块
  s = s.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[+i]);
  return s;
}

/** 给代码块/表格套一层限宽滚动容器——这是长文不撑破气泡的关键。 */
function wrapOverflow(html) {
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    '<div class="code-wrap"><pre><code>$1</code></pre></div>');
  html = html.replace(/<table>([\s\S]*?)<\/table>/g,
    '<div class="table-wrap"><table>$1</table></div>');
  return html;
}

/* ============================== 头像 ============================== */
async function loadAvatar() {
  try {
    const res = await api('/api/auth/avatar', { noProfileHeader: true });
    const raw = res && res.avatar;
    if (!raw) return;
    let obj = typeof raw === 'string' ? safeJson(raw, null) : raw;
    if (!obj) return;
    if (obj.type === 'image' && obj.dataUrl) {
      state.avatar = obj.dataUrl;
      state.avatarSeed = '';
    } else {
      state.avatar = '';
      state.avatarSeed = obj.seed || state.user || 'H';
    }
    if (state.view === 'chat') renderMsgs();
  } catch (e) { /* 头像失败不影响主流程 */ }
}

function initial(name) {
  const s = String(name || '').trim();
  return s ? s[0].toUpperCase() : 'H';
}

/** 用户侧头像 HTML */
function userAvatarHtml() {
  if (state.avatar) return '<img class="avatar" alt="" src="' + esc(state.avatar) + '">';
  return '<div class="avatar def user-def">' + esc(initial(state.avatarSeed || state.user)) + '</div>';
}

/** 助手侧头像：Hermes Agent 官方图标（本地资源，深色界面友好）。 */
function botAvatarHtml() {
  return '<img class="avatar" alt="Hermes" src="hermes-bot.png">';
}

/** 用户侧头像用服务器头像，否则退化成官方图标。 */
function fallbackAvatarHtml() {
  return userAvatarHtml();
}

/* ============================== 思考计时 ============================== */
/**
 * 复刻 web 端 MessageList.vue 的思考计时：
 * - formatElapsed 与 web 完全一致（1h2m3s / 2m3s / 45s）
 * - 起始时间优先用服务端 `resumed.runStartedAt`（中途打开也能显示同一进度，
 *   web 也是这么做的），拿不到才用本地 Date.now()
 * - 每秒 tick 一次；run 结束即停
 */
let thinkingTimer = null;
let thinkingStartedAt = 0;

function formatElapsed(ms) {
  const totalSeconds = Math.floor((Number(ms) || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return hours + 'h' + mins + 'm' + secs + 's';
  if (mins > 0) return mins + 'm' + secs + 's';
  return secs + 's';
}

function thinkingTick() {
  const elapsed = Math.max(0, Date.now() - thinkingStartedAt);
  // 有排队消息时优先显示排队状态（否则计时会把排队提示刷掉）
  if (state.queued.length) {
    updateChatSub('排队中（' + state.queued.length + '）· ' + formatElapsed(elapsed));
  } else {
    updateChatSub('正在思考 ' + formatElapsed(elapsed));
  }
}

function startThinkingAt(startedAt) {
  const t = Number(startedAt) || 0;
  thinkingStartedAt = t > 0 ? t : Date.now();
  stopThinkingTimer();
  thinkingTick();
  thinkingTimer = setInterval(thinkingTick, 1000);
}

function stopThinkingTimer() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

/* ============================== 视图切换 ============================== */
function show(view) {
  state.view = view;
  for (const v of ['login', 'sessions', 'wecom', 'settings', 'chat', 'workbench']) {
    const el = $('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  }
  if (view === 'login') renderStudioList();
  if (view === 'settings') renderSettings();
  if (view === 'workbench') renderWorkbench();
}

function switchTab(tab) {
  if (tab === 'sessions') { show('sessions'); loadSessions(); }
  else if (tab === 'wecom') { show('wecom'); loadWecom(); }
  else if (tab === 'workbench') { show('workbench'); renderWorkbench(); }
  else if (tab === 'settings') show('settings');
}

window.__onBack = function () {
  if (state.wb && state.wb.key && !$('wb-sheet').classList.contains('hidden')) { wbClose(); return true; }
  if (state.view === 'chat') { closeChat(); return true; }
  if (state.view === 'wecom' || state.view === 'settings' || state.view === 'workbench') { switchTab('sessions'); return true; }
  if (state.searchMode) { toggleSearch(false); return true; }
  return false;
};

/* ============================== 登录 ============================== */
function fillLogin() {
  $('login-base').value = state.base;
  $('login-user').value = state.user;
}

async function doLogin() {
  const base = $('login-base').value.trim().replace(/\/$/, '');
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  const errEl = $('login-error');
  errEl.textContent = '';
  if (!base || !user || !pass) { errEl.textContent = '请填写服务器地址、用户名和密码'; return; }

  // 服务器地址变了：必须先让原生端以新 origin 重新加载页面，否则 socket.io 会拒绝（origin not allowed）
  if (nativeBase() && base !== nativeBase()) {
    errEl.textContent = '正在切换到 ' + base + '，页面将重新加载，请再登录一次…';
    if (setNativeBase(base)) return;
  }

  $('login-btn').disabled = true;
  const started = Date.now();
  errEl.textContent = '登录中…';
  try {
    state.base = base;
    const res = await api('/api/auth/login', { method: 'POST', body: { username: user, password: pass }, noProfileHeader: true });
    state.token = res.token;
    state.user = user;
    state.profiles = res.profiles || [];
    if (!state.profiles.includes(state.profile)) {
      state.profile = state.profiles[0] || 'default';
    }
    localStorage.setItem('hm_base', base);
    localStorage.setItem('hm_token', state.token);
    localStorage.setItem('hm_user', user);
    localStorage.setItem('hm_profile', state.profile);
    localStorage.setItem('hm_profiles', JSON.stringify(state.profiles));
    $('login-pass').value = '';
    rememberStudio();
    // 探测 Studio 版本：低于 0.7.13 时协议字段不全（Ekko App 也直接拒绝）
    await probeStudio();
    if (state.studio.version && !studioVersionOk(state.studio.version)) {
      state.token = '';
      localStorage.removeItem('hm_token');
      errEl.textContent = 'Studio 版本过低：v' + state.studio.version +
        '，本客户端要求 ≥ ' + MIN_STUDIO_VERSION + '。请先升级 Studio（Web 版同一套升级方式）。';
      return;
    }
    connectSocket();
    loadAvatar();          // 登录后拉头像（失败不影响主流程）
    switchTab('sessions');
  } catch (e) {
    // 静默失败是这个应用最常见的坑（旧包残留 / origin 不匹配 / ROM 拦明文 / 端口不通），
    // 所以这里把错误原样显示出来，而不是让它看起来像「按钮没反应」。
    const ms = Date.now() - started;
    const msg = (e && e.message) || '登录失败';
    errEl.textContent = '登录失败（' + ms + 'ms）：' + msg;
    errEl.classList.add('login-error--verbose');
    console.error('[login] failed', { base, user, ms, message: msg, stack: e && e.stack });
  } finally {
    $('login-btn').disabled = false;
    errEl.classList.remove('login-error--verbose');
  }
}

function logout(expired) {
  state.token = '';
  localStorage.removeItem('hm_token');
  if (state.socket) { try { state.socket.disconnect(); } catch (e) {} state.socket = null; }
  show('login');
  fillLogin();
  renderStudioList();
  if (expired) $('login-error').textContent = '登录已过期，请重新登录';
}

/* ============================== Socket.IO ============================== */
/** 是否经历过一次断线（用于重连后决定要不要重新同步）。 */
let sawDisconnect = false;

/**
 * 重新同步当前打开的会话。
 * 复刻 web 的重连/回前台处理：拉回已完成的历史 + 重新 resume 拿实时状态。
 * 这是"卡死、要退出重进才更新"的解药——错过的事件靠这次补齐。
 */
async function resyncOpenSession() {
  if (!state.token) return;
  loadSessions();
  if (!state.cur) return;
  await loadMessages();       // REST 是权威：把已完成的内容拉回来
  loadContextUsage();
  if (state.socket && state.socket.connected) {
    try { state.socket.emit('resume', { session_id: state.cur, profile: state.profile }); } catch (e) {}
  }
}

function connectSocket() {
  if (state.socket) { try { state.socket.disconnect(); } catch (e) {} }
  if (typeof io === 'undefined') { setConn('socket.io 缺失'); return; }

  const sock = io(state.base.replace(/\/$/, '') + '/chat-run', {
    auth: { token: state.token },
    query: { profile: state.profile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    timeout: 30000,
  });
  state.socket = sock;

  sock.on('connect', () => {
    setConn('已连接');
    // 复刻 web 的 emitReconnectResume：断线重连后必须重新 resume + 拉历史，
    // 否则运行中错过的 run.completed/delta 永远不会补上，界面就"卡死"在旧状态。
    if (sawDisconnect) {
      sawDisconnect = false;
      resyncOpenSession();
    }
  });
  sock.on('disconnect', (r) => {
    setConn('已断开（' + r + '）');
    sawDisconnect = true;
  });
  sock.on('connect_error', (e) => {
    setConn('连接失败：' + (e && e.message ? e.message : e));
    sawDisconnect = true;
  });

  const on = (ev, fn) => sock.on(ev, (data) => {
    state.lastEventAt = Date.now();   // 记录最近一次事件（看门狗用）
    try { fn(data || {}); } catch (e) { console.error(ev, e); }
  });

  // ---- 流式文本 ----
  on('message.delta', (ev) => {
    if (!isMine(ev)) return;
    if (state.cur === ev.session_id) {
      if (!state.streaming || state.streaming.sid !== ev.session_id) startStream(ev.session_id);
      state.streaming.text += (ev.delta || '');
      state.streaming.thinking = false;   // 正文开始流 → 思考阶段结束，思考条立刻隐藏（不占位）
      paintStream();
    }
    markWorking(ev.session_id, true);
    touchSessionPreview(ev.session_id, ev.delta || '');
  });
  on('message.interim', (ev) => {
    if (!isMine(ev) || state.cur !== ev.session_id) return;
    if (state.streaming && ev.already_streamed) return;
    if (!state.streaming || state.streaming.sid !== ev.session_id) startStream(ev.session_id);
    state.streaming.text = ev.delta || ev.output || ev.text || '';
    state.streaming.thinking = false;
    paintStream();
  });

  // ---- 思考 ----
  const reasoning = (ev) => {
    if (!isMine(ev)) return;
    if (state.cur !== ev.session_id) return;
    if (!state.streaming || state.streaming.sid !== ev.session_id) startStream(ev.session_id);
    state.streaming.reasoning += (ev.text || ev.delta || '');
    state.streaming.thinking = true;    // 思考阶段开始（只占一行，见 reasoningLineHtml）
    paintStream();
  };
  on('reasoning.delta', reasoning);
  on('thinking.delta', reasoning);
  on('reasoning.available', reasoning);
  on('moa.reference', reasoning);

  // ---- 工具 ----
  // 同一条工具调用只占一条行：按 (run, tool_call_id) upsert，started 建行（运行中），
  // completed/failed 就地改状态。旧写法 started/completed 各推一行、且都不带 run 标识，
  // 于是「会话激活期工具全是单条，切走再切回重拉历史才整合」。
  on('tool.started', (ev) => {
    if (!isMine(ev)) return;
    if (state.streaming) state.streaming.thinking = false;   // 去调工具 → 这段思考结束
    markWorking(ev.session_id, true);
    if (state.cur === ev.session_id) upsertLiveTool(ev, 'running');
  });
  on('tool.completed', (ev) => {
    if (!isMine(ev)) return;
    if (state.cur === ev.session_id) upsertLiveTool(ev, 'done');
  });
  on('tool.failed', (ev) => {
    if (!isMine(ev)) return;
    if (state.cur === ev.session_id) upsertLiveTool(ev, 'error');
  });
  on('agent.event', (ev) => {
    if (!isMine(ev) || state.cur !== ev.session_id) return;
    if (ev.name || ev.tool) addToolRow('· ' + (ev.name || ev.tool), ev.preview || '');
  });

  // ---- 运行生命周期 ----
  on('run.started', (ev) => {
    markWorking(ev.session_id, true);
    if (state.cur === ev.session_id) {
      // 本轮 live 工具行的归组键（socket 事件只带 run_id）
      state.activeRunId = String(ev.run_marker || ev.run_id || '').trim() || state.activeRunId;
      if (!state.streaming || state.streaming.sid !== ev.session_id) startStream(ev.session_id);
      startThinkingAt(ev.runStartedAt || 0);   // 计时（无服务端起始时间则用本地 now）
    }
  });
  on('run.queued', (ev) => {
    if (state.cur !== ev.session_id) return;
    // 服务端把某条排队消息取出来开跑（dequeued_queue_id）→ 此时才把它挪进消息流。
    // 只有这一次迁移，排队期间它只属于排队区（用户 2026-10-05 报的重复显示）。
    const dequeuedId = ev.dequeued_queue_id != null ? String(ev.dequeued_queue_id) : '';
    if (dequeuedId) {
      const q = (state.queued || []).find((x) => String(x.id) === dequeuedId);
      promoteQueuedMessage(q, dequeuedId);
    }
    // 服务端在 run.queued 里附带队列快照（权威）
    applyQueueSnapshot(ev);
    if (thinkingTimer) thinkingTick();          // 让计时立刻反映排队
    else if (state.queued.length) updateChatSub('排队中…（' + state.queued.length + '）');
    renderMsgs();
    if (dequeuedId) jumpToLatest();             // 刚开跑的那条要出现在最新位置
  });
  on('run.completed', (ev) => {
    markWorking(ev.session_id, false);
    if (state.cur === ev.session_id) {
      finishStream(ev.output, ev.error);
      settleLiveTools('done');    // 复刻 web settleRunningTools：漏掉 completed 的行也要收尾
      reconcileQueueAfterRun(ev.queue_remaining);
      if (ev.contextTokens != null) setContextTokens(ev.contextTokens);
      stopThinkingTimer();
      updateChatSub(subLine(state.curModel));
      loadContextUsage();     // 一轮跑完，用量变了
      // 本轮文件变更卡（web 的 WorkspaceRunChangeSummary）
      const change = ev.workspace_run_change;
      if (change && Number(change.files_changed) > 0) {
        state.cards.push({
          kind: 'diff',
          id: 'diff-' + (change.change_id || Date.now()),
          sid: ev.session_id,
          change: change,
        });
        renderCards();
      }
      state.plan = null;      // 一轮结束，计划卡由新一次 plan.updated 重建
      renderCards();
    }
    loadSessionsSoon();
  });
  on('run.failed', (ev) => {
    markWorking(ev.session_id, false);
    if (state.cur === ev.session_id) {
      finishStream(null, ev.error || '运行失败');
      settleLiveTools('error');
      reconcileQueueAfterRun(ev.queue_remaining);
      stopThinkingTimer();
      updateChatSub(subLine(state.curModel));
      loadContextUsage();
    }
    loadSessionsSoon();
  });
  on('abort.completed', (ev) => {
    markWorking(ev.session_id, false);
    if (state.cur === ev.session_id) {
      finishStream(null, null);
      settleLiveTools('done');
      reconcileQueueAfterRun(ev.queue_length);
      stopThinkingTimer();
      updateChatSub(subLine(state.curModel));
    }
  });

  // ---- 会话活动（服务端权威）----
  // 列表里的「● 运行中」不能只靠当前会话的 run 事件：
  //   · run.completed 只发给 `session:<id>` 房间（或发起它的那个 socket），
  //     App 切后台/断线重连后不在房间里 → 这条事件永久错过 → 列表一直挂着「运行中」，
  //     要手动点进会话触发 resume 才消。
  //   · 别的端（网页/企微/另一台设备）发起的 run，App 本来也收不到。
  // 服务端为此另发两条**与房间无关**的事件（见 chat-run.ts onConnection / emitSessionActivity）：
  //   · `session.activity.snapshot`：每次连上（含重连）发一次，权威列出该 profile 正在跑的会话；
  //   · `session.activity`：每次 run 生命周期（started/completed/failed/abort）广播给
  //     `pending-interactions:<profile>` 房间——App 连上时就被服务端自动加进这个房间。
  on('session.activity.snapshot', (ev) => {
    const running = new Set((ev.sessions || [])
      .map((s) => String((s && s.session_id) || ''))
      .filter(Boolean));
    // 快照是「此刻在跑什么」的权威答案：不在里面的就不是在跑。
    // 本地乐观态（刚点发送、服务端还没起跑）由随后的 run.started 补回来。
    for (const sid of Object.keys(state.working)) {
      if (!running.has(sid)) delete state.working[sid];
    }
    for (const sid of running) state.working[sid] = true;
    syncStopButton();
    renderVisibleLists();
  });
  on('session.activity', (ev) => {
    if (!ev.session_id) return;
    markWorking(String(ev.session_id), ev.status === 'running');
  });

  // ---- 会话元数据（web 端改动实时同步）----
  on('session.title.updated', (ev) => {
    const s = state.sessions.find((x) => x.id === ev.session_id);
    if (s && ev.title) { s.title = ev.title; if (state.view === 'sessions') renderSessions(); }
    if (state.cur === ev.session_id && ev.title) {
      state.curTitle = ev.title;
      $('chat-title').textContent = ev.title;
    }
  });
  on('session.settings.updated', (ev) => {
    if (state.cur === ev.session_id && ev.model) state.curModel = ev.model;
  });
  on('run.peer_user_message', (ev) => {
    if (state.cur !== ev.session_id) return;
    const m = ev.message;
    if (m && m.content) {
      // 去重：服务端排除的是"投递那条排队消息的 socket.id"（peerExcludeSocketId=originSocketId），
      // 但 App 重连后 socket.id 变了 → 排除失效 → 会把自己刚插入的排队消息当"对端消息"回推。
      // 本地已经通过 run.queued(dequeued_queue_id) 把它 promote 进消息流，再追加就是两条一样的。
      // 服务端回推时 `id` 就是 queue_id（handle-bridge-run: id: data.queue_id || messageId），
      // 而本地 promote 时把它记在 msg.queueId 上 —— 按这个键精确去重。
      // ⚠️ 不能用"内容相同"去重：用户连着发两条一样的话是合法操作（2026-10-05 截图里就是）。
      const mid = m.id != null ? String(m.id) : '';
      const already = mid && state.msgs.some((x) => String(x.queueId || '') === mid);
      if (!already) addMsg({ role: 'user', content: m.content, ts: m.timestamp });
    }
    loadSessionsSoon();
  });

  // ---- 任务计划 / 压缩 / 命令回显（对齐 web 的事件语义）----
  on('plan.updated', (ev) => {
    if (!ev || ev.session_id !== state.cur) return;
    state.plan = ev;
    renderCards();
  });
  on('compression.started', (ev) => {
    if (state.cur !== ev.session_id) return;
    addMsg({ role: 'system', content: '正在压缩上下文…' });
  });
  on('compression.completed', (ev) => {
    if (state.cur !== ev.session_id) return;
    const before = Number(ev.beforeTokens || ev.before_tokens || 0);
    const after = Number(ev.afterTokens || ev.after_tokens || 0);
    const detail = before && after ? '（' + fmtTokens(before) + ' → ' + fmtTokens(after) + '）' : '';
    addMsg({ role: 'system', content: '上下文压缩完成' + detail });
  });
  on('session.command', (ev) => {
    if (state.cur !== ev.session_id) return;
    const cmd = ev.command || ev.text || ev.name || '';
    if (cmd) addMsg({ role: 'system', content: '⌘ ' + String(cmd).slice(0, 200) });
  });

  // ---- 审批 / 追问 ----
  on('approval.requested', (ev) => {
    if (state.cur !== ev.session_id) return;
    state.cards.push({
      kind: 'approval', id: ev.approval_id || ev.id || String(Date.now()),
      sid: ev.session_id,
      title: '工具调用需要批准' + (ev.tool ? '：' + ev.tool : ''),
      body: ev.preview || ev.summary || (typeof ev.arguments === 'string' ? ev.arguments : JSON.stringify(ev.arguments || ev.reason || '', null, 2)),
    });
    renderCards();
  });
  on('approval.resolved', (ev) => {
    state.cards = state.cards.filter((c) => !(c.kind === 'approval' && (c.id === ev.approval_id || c.id === ev.id)));
    renderCards();
  });
  on('clarify.requested', (ev) => {
    if (state.cur !== ev.session_id) return;
    state.cards.push({
      kind: 'clarify', id: ev.clarify_id || ev.id || String(Date.now()),
      sid: ev.session_id,
      title: ev.title || '需要你的补充说明',
      body: ev.question || ev.body || ev.preview || '',
    });
    renderCards();
  });
  on('clarify.resolved', (ev) => {
    state.cards = state.cards.filter((c) => !(c.kind === 'clarify' && (c.id === ev.clarify_id || c.id === ev.id)));
    renderCards();
  });

  // ---- resume 应答（打开会话时确认工作状态 / 队列）----
  on('resumed', (data) => {
    if (data.session_id !== state.cur) return;
    markWorking(data.session_id, !!data.isWorking);
    if (data.isWorking) {
      // 中途打开会话：历史里最新的 run_marker 就是正在跑的那一轮，
      // 让后续 live 工具条目并进已在屏的那一组（否则会另起一组）
      state.activeRunId = state.lastHistoryRun || state.activeRunId;
    }
    if (data.isWorking && !state.streaming) startStream(data.session_id);
    if (data.model) state.curModel = data.model;
    // 真实上下文占用（web 版也是用这个）
    setContextTokens(data.contextTokens);
    // resumed 里带队列快照：queueLength + queueMessages
    applyQueueSnapshot(data);
    renderMsgs();
    loadContextUsage();
    if (data.isWorking) {
      // 中途打开也接着服务端给的起始时间算（web 同款，跨设备一致）
      startThinkingAt(data.runStartedAt || 0);
    } else {
      // 服务端说没在跑：把可能残留的流式气泡收尾。
      // 不这样做的话，错过的 run.completed 会让"思考中…▍"一直挂着，看着像卡死。
      if (state.streaming) finishStream(null, null);
      stopThinkingTimer();
      updateChatSub(subLine(state.curModel));
    }
  });

  // 服务端实时上报用量：contextTokens 是当前上下文占用
  on('usage.updated', (ev) => {
    if (ev.session_id && ev.session_id !== state.cur) return;
    setContextTokens(ev.contextTokens);
    if (state.cur) loadContextUsage();
  });

  // 插入排队消息的进度（服务端在安全边界推进时推这个）
  on('run.queue_insertion.updated', (ev) => {
    if (ev.session_id && ev.session_id !== state.cur) return;
    state.queueInsertingId = ev.queue_id || null;
    renderMsgs();
  });
}

/** 把服务端带回的队列快照写进 state.queued（字段名两处兼容）。 */
function applyQueueSnapshot(data) {
  const raw = data.queueMessages || data.queued_messages || [];
  const prev = new Map((state.queued || []).map((q) => [String(q.id), q]));
  state.queued = Array.isArray(raw) ? raw.map((m) => {
    const id = String(m.id != null ? m.id : (m.queue_id || ''));
    const old = prev.get(id) || {};
    return {
      id,
      role: String(m.role || old.role || 'user'),
      content: String(m.content || old.content || ''),
      images: old.images || null,   // 服务端快照只有文本，图片留本地那份
      ts: typeof m.timestamp === 'number' ? m.timestamp : (old.ts || Date.now() / 1000),
      queued: true,
    };
  }) : [];
}

/**
 * 排队消息真正开跑：把它从排队区挪进消息流（复刻 web 的 `dequeued_queue_id` 处理）。
 * 同一 queueId 只插一次——事件（resume 重放）重复到达时不会插两条。
 */
function promoteQueuedMessage(q, queueId) {
  if (!q) return;
  const id = String(queueId || q.id || '');
  if (!id) return;
  if (state.msgs.some((m) => m.queueId && String(m.queueId) === id)) return;
  state.msgs.push({
    key: 'u' + Date.now() + Math.random().toString(36).slice(2, 5),
    role: q.role || 'user',
    content: q.content || '',
    images: q.images || null,
    queueId: id,
    ts: q.ts || Date.now() / 1000,
  });
}

/**
 * 一轮跑完后的队列收尾。
 * 队列以服务端的 run.queued 快照为准，所以**不能**直接清空：未完的排队消息还要留着，
 * 而且 dequeue 事件会晚于 run.completed 到达。只有服务端说队列已空、本地却还剩条目时
 * （说明漏了 dequeue 事件）才把它们收进消息流，宁可显示出来也不要凭空消失。
 */
function reconcileQueueAfterRun(remaining) {
  const left = Number(remaining || 0);
  if (left > 0 || !state.queued.length) return;
  state.queued.forEach((q) => promoteQueuedMessage(q, q.id));
  state.queued = [];
}

function isMine(ev) {
  // 有些事件会带 session_id；没有的忽略
  return ev && typeof ev.session_id === 'string' && ev.session_id.length > 0;
}

function setConn(text) {
  const el = $('set-conn');
  if (el) el.textContent = text;
}

/* ============================== 会话列表 ============================== */
let loadSessionsTimer = null;
function loadSessionsSoon() {
  clearTimeout(loadSessionsTimer);
  loadSessionsTimer = setTimeout(loadSessions, 2500);
}

async function loadSessions() {
  if (!state.token) return;
  try {
    const qs = '?limit=80&profile=' + encodeURIComponent(state.profile);
    const res = await api('/api/studio/sessions' + qs, { noProfileHeader: true });
    state.sessions = res.sessions || [];
    await loadCategories();
    updateCatChip();      // 会话归属可能被别处（Web 版）改过
    if (state.view === 'sessions') renderSessions();
  } catch (e) {
    if (state.view === 'sessions') $('session-list').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

/** 会话分类列表（分组渲染用）。 */
async function loadCategories() {
  try {
    const res = await api('/api/studio/session-categories?profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
    state.categories = res.categories || [];
  } catch (e) {
    state.categories = state.categories || [];
  }
}

function categoryName(id) {
  const c = (state.categories || []).find((x) => x.id === id);
  return c ? c.name : '';
}

/* ==================== 会话分类（对齐 web：CRUD + 会话归属 + 新建时选分类） ==================== */

/** 该分类下的会话数（以本地已拉取的会话为准，与列表角标同口径）。 */
function categoryCount(id) {
  return (state.sessions || []).filter((s) => s.category_id === id).length;
}

async function apiCreateCategory(name) {
  const res = await api('/api/studio/session-categories', { method: 'POST', body: { name } });
  return res.category;
}
async function apiRenameCategory(id, name) {
  const res = await api('/api/studio/session-categories/' + encodeURIComponent(String(id)),
    { method: 'PATCH', body: { name } });
  return res.category;
}
async function apiDeleteCategory(id) {
  return api('/api/studio/session-categories/' + encodeURIComponent(String(id)), { method: 'DELETE' });
}
/** 改归属：已存在的会话走 REST（categoryId 为 null 即「未分类」）。 */
async function apiSetSessionCategory(sid, categoryId) {
  return api('/api/studio/sessions/' + encodeURIComponent(sid) + '/category',
    { method: 'POST', body: { categoryId } });
}

/** 通用底部动作表。rows=[{key,label,note,active,danger}] → 返回 key 或 null（取消）。 */
function actionSheet(title, rows) {
  return new Promise((resolve) => {
    const wrap = $('menu-sheet');
    $('menu-title').textContent = title || '';
    const list = $('menu-list');
    list.innerHTML = rows.map((r) =>
      '<button class="menu-item' + (r.danger ? ' danger' : '') + (r.active ? ' active' : '') +
        '" data-key="' + esc(r.key) + '">' +
        '<span class="menu-label">' + esc(r.label) + '</span>' +
        (r.note ? '<span class="menu-note">' + esc(r.note) + '</span>' : '') +
      '</button>').join('');
    wrap.classList.remove('hidden');
    const finish = (key) => {
      wrap.classList.add('hidden');
      wrap.onclick = null;
      $('menu-cancel').onclick = null;
      list.querySelectorAll('.menu-item').forEach((b) => { b.onclick = null; });
      resolve(key);
    };
    list.querySelectorAll('.menu-item').forEach((b) => {
      b.onclick = () => finish(b.getAttribute('data-key'));
    });
    $('menu-cancel').onclick = () => finish(null);
    wrap.onclick = (e) => { if (e.target === wrap) finish(null); };
  });
}

/** 通用输入弹窗（WebView 里 window.prompt 不可用）→ 文本或 null。 */
function promptDialog(title, value, placeholder) {
  return new Promise((resolve) => {
    const wrap = $('modal');
    $('modal-title').textContent = title || '';
    $('modal-body').innerHTML = '<input type="text" id="modal-input">';
    const inp = $('modal-input');
    inp.value = value || '';
    inp.placeholder = placeholder || '';
    wrap.classList.remove('hidden');
    const finish = (v) => {
      wrap.classList.add('hidden');
      wrap.onclick = null; inp.onkeydown = null;
      $('modal-ok').onclick = null; $('modal-cancel').onclick = null;
      resolve(v);
    };
    $('modal-ok').onclick = () => {
      const v = inp.value.trim();
      if (!v) { toast('名称不能为空'); return; }
      finish(v);
    };
    $('modal-cancel').onclick = () => finish(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('modal-ok').click(); };
    wrap.onclick = (e) => { if (e.target === wrap) finish(null); };
    setTimeout(() => { try { inp.focus(); } catch (err) {} }, 40);
  });
}

/** 通用确认弹窗 → boolean。 */
function confirmDialog(title, body) {
  return new Promise((resolve) => {
    const wrap = $('modal');
    $('modal-title').textContent = title || '';
    $('modal-body').innerHTML = '<div>' + esc(body || '') + '</div>';
    wrap.classList.remove('hidden');
    const finish = (v) => {
      wrap.classList.add('hidden');
      wrap.onclick = null;
      $('modal-ok').onclick = null; $('modal-cancel').onclick = null;
      resolve(v);
    };
    $('modal-ok').onclick = () => finish(true);
    $('modal-cancel').onclick = () => finish(false);
    wrap.onclick = (e) => { if (e.target === wrap) finish(false); };
  });
}

/** 长按（550ms）→ 打开菜单；鼠标右键同样触发（便于桌面/自动化验证）。 */
function bindLongPress(el, fn) {
  let timer = null;
  let x0 = 0;
  let y0 = 0;
  const point = (e) => (e.touches && e.touches[0]) || e;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', (e) => {
    const p = point(e);
    x0 = p.clientX; y0 = p.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      el._lp = Date.now();      // 标记，避免抬手后又被当成普通点击
      fn();
    }, 550);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const p = point(e);
    if (Math.abs(p.clientX - x0) > 12 || Math.abs(p.clientY - y0) > 12) cancel();
  }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); el._lp = Date.now(); fn(); });
}

/** 新建分类（重名 / 超长由服务端报错后 toast）。 */
async function createCategoryFlow() {
  const name = await promptDialog('新建分类', '', '分类名称（最多 20 字）');
  if (!name) return null;
  try {
    const c = await apiCreateCategory(name);
    await loadCategories();
    renderSessions();
    updateCatChip();
    toast('已新建分类「' + c.name + '」');
    return c;
  } catch (e) {
    toast('新建失败：' + e.message);
    return null;
  }
}

/** 分类选择器 → 分类 id / null=未分类 / undefined=取消。 */
async function pickCategory(title) {
  await loadCategories();
  const rows = [{ key: 'none', label: '未分类' }];
  for (const c of state.categories || []) rows.push({ key: 'c' + c.id, label: c.name });
  rows.push({ key: 'new', label: '＋ 新建分类' });
  const key = await actionSheet(title || '选择分类', rows);
  if (key == null) return undefined;
  if (key === 'none') return null;
  if (key === 'new') {
    const c = await createCategoryFlow();
    return c ? c.id : undefined;
  }
  return Number(key.slice(1));
}

/** 单个分类的操作：重命名 / 删除。 */
async function openCategoryActions(id) {
  const name = categoryName(id);
  const act = await actionSheet(name || '分类', [
    { key: 'rename', label: '重命名' },
    { key: 'delete', label: '删除分类', note: categoryCount(id) + ' 个会话将变为未分类', danger: true },
  ]);
  if (act === 'rename') {
    const next = await promptDialog('重命名分类', name, '分类名称');
    if (!next || next === name) return;
    try {
      await apiRenameCategory(id, next);
      await loadCategories();
      renderSessions();
      updateCatChip();
      toast('已重命名为「' + next + '」');
    } catch (e) { toast('重命名失败：' + e.message); }
    return;
  }
  if (act === 'delete') {
    const ok = await confirmDialog('删除分类「' + name + '」？', '分类下的会话不会被删除，会回到「未分类」。');
    if (!ok) return;
    try {
      await apiDeleteCategory(id);
      await loadCategories();
      await loadSessions();      // 服务端可能已把会话的 category_id 置空，重拉一次
      updateCatChip();
      toast('已删除分类');
    } catch (e) { toast('删除失败：' + e.message); }
  }
}

/** 分类管理入口（会话页 🏷）：列分类 → 逐项操作；也能新建。 */
async function openCategoryManager() {
  await loadCategories();
  const rows = (state.categories || []).map((c) => ({
    key: 'c' + c.id, label: c.name, note: categoryCount(c.id) + ' 个会话',
  }));
  rows.push({ key: 'new', label: '＋ 新建分类' });
  const key = await actionSheet('分类管理', rows);
  if (key == null) return;
  if (key === 'new') { await createCategoryFlow(); return; }
  await openCategoryActions(Number(key.slice(1)));
}

/** 会话行菜单（⋯ / 长按）：打开、重命名、置顶、分类、归档、删除。 */
async function openSessionMenu(sid) {
  const s = (state.sessions || []).find((x) => x.id === sid);
  if (!s) return;
  const pinned = !!(s.is_pinned === true || s.is_pinned === 1);
  const archived = !!(s.is_archived === true || s.is_archived === 1);
  const key = await actionSheet(s.title || '（未命名会话）', [
    { key: 'open', label: '打开会话' },
    { key: 'rename', label: '重命名' },
    { key: 'pin', label: pinned ? '取消置顶' : '置顶', active: pinned },
    { key: 'cat', label: '移动到分类', note: (s.category_id != null && categoryName(s.category_id)) || '未分类' },
    { key: 'archive', label: archived ? '取消归档' : '归档' },
    { key: 'delete', label: '删除会话', note: '不可恢复', danger: true },
  ]);
  if (key === 'open') { openSession(sid, s.title || '', false, s.model || ''); return; }
  if (key === 'rename') { renameSessionFlow(s); return; }
  if (key === 'pin') { togglePinSession(s, !pinned); return; }
  if (key === 'archive') { archiveSessionFlow(s, !archived); return; }
  if (key === 'delete') { deleteSessionFlow(s); return; }
  if (key !== 'cat') return;
  const id = await pickCategory('移动到分类');
  if (id === undefined) return;
  if ((s.category_id == null ? null : s.category_id) === id) return;
  try {
    await apiSetSessionCategory(sid, id);
    s.category_id = id;
    renderSessions();
    updateCatChip();
    toast(id == null ? '已移到「未分类」' : '已移到「' + categoryName(id) + '」');
  } catch (e) { toast('移动失败：' + e.message); }
}

/** 重命名会话（POST /api/studio/sessions/:id/rename）。 */
async function renameSessionFlow(s) {
  const next = await promptDialog('重命名会话', s.title || '', '会话标题');
  if (!next || next === s.title) return;
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(s.id) + '/rename',
      { method: 'POST', body: { title: next } });
    s.title = next;
    if (state.cur === s.id) {
      state.curTitle = next;
      $('chat-title').textContent = next;
    }
    renderSessions();
    toast('已重命名');
  } catch (e) {
    toast('重命名失败：' + ((e && e.message) || e));
  }
}

/** 置顶 / 取消置顶（POST /api/studio/sessions/:id/pin）。 */
async function togglePinSession(s, pin) {
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(s.id) + '/pin',
      { method: 'POST', body: { is_pinned: pin } });
    s.is_pinned = pin ? 1 : 0;
    renderSessions();
    toast(pin ? '已置顶' : '已取消置顶');
  } catch (e) {
    toast('操作失败：' + ((e && e.message) || e));
  }
}

/** 归档 / 取消归档（POST /api/studio/sessions/:id/(un)archive）。 */
async function archiveSessionFlow(s, archive) {
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(s.id) + (archive ? '/archive' : '/unarchive'),
      { method: 'POST' });
    if (archive) {
      state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
    } else {
      s.is_archived = 0;
    }
    renderSessions();
    toast(archive ? '已归档' : '已取消归档');
  } catch (e) {
    toast('操作失败：' + ((e && e.message) || e));
  }
}

/** 删除会话（DELETE /api/studio/sessions/:id?profile=）。 */
async function deleteSessionFlow(s) {
  const ok = await confirmDialog('删除会话「' + (s.title || '未命名') + '」？',
    '会话与消息会从 Studio 里删除，无法恢复（企微历史会话同理）。');
  if (!ok) return;
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(s.id) +
      '?profile=' + encodeURIComponent(state.profile), { method: 'DELETE' });
    state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
    if (state.cur === s.id) closeChat();
    renderSessions();
    toast('已删除');
  } catch (e) {
    toast('删除失败：' + ((e && e.message) || e));
  }
}

/** 当前会话该显示的分类 id（新会话取待定值，老会话取服务端归属）。 */
function chatCategoryId() {
  if (state.curHermes) return null;
  const s = (state.sessions || []).find((x) => x.id === state.cur);
  if (s) return s.category_id == null ? null : s.category_id;
  return state.newSessionCategoryId == null ? null : state.newSessionCategoryId;
}

/** 聊天页「分类」按钮文案（新会话=待定归属，老会话=当前归属）。 */
function updateCatChip() {
  const btn = $('chat-cat');
  if (!btn) return;
  btn.classList.toggle('hidden', !!state.curHermes || !state.cur);
  setPillText(btn, categoryName(chatCategoryId()) || '未分类');
}

/** 顶栏 pill 的文案只改 <span>，不动 SVG 图标（textContent 会把 icon 一起清掉）。 */
function setPillText(btn, text) {
  if (!btn) return;
  const span = btn.querySelector('span');
  if (span) span.textContent = String(text == null ? '' : text);
  else btn.textContent = String(text == null ? '' : text);
}

function renderCatSheet() {
  const cur = chatCategoryId();
  const rows = [{ key: 'none', label: '未分类' }];
  for (const c of state.categories || []) rows.push({ key: 'c' + c.id, label: c.name });
  $('cat-list').innerHTML = rows.map((r) => {
    const id = r.key === 'none' ? null : Number(r.key.slice(1));
    const active = (cur == null ? null : cur) === id;
    return '<button class="cat-item' + (active ? ' active' : '') + '" data-key="' + esc(r.key) + '">' +
      '<span class="cat-name">' + esc(r.label) + '</span>' +
      (id == null ? '' : '<span class="cat-count">' + categoryCount(id) + '</span>') +
      (active ? '<span class="cat-check">✓</span>' : '') +
    '</button>';
  }).join('');
  $('cat-list').querySelectorAll('.cat-item').forEach((b) => {
    b.addEventListener('click', () => applyChatCategory(b.getAttribute('data-key')));
  });
}

/** 聊天页选中分类：新会话先记住（随首个 run 落库），老会话直接改。 */
async function applyChatCategory(key) {
  const id = key === 'none' ? null : Number(key.slice(1));
  const s = (state.sessions || []).find((x) => x.id === state.cur);
  if (!s) {
    state.newSessionCategoryId = id;
    $('chat-cat-sheet').classList.add('hidden');
    updateCatChip();
    renderCatSheet();
    toast('新会话将归到「' + (categoryName(id) || '未分类') + '」');
    return;
  }
  if ((s.category_id == null ? null : s.category_id) === id) {
    $('chat-cat-sheet').classList.add('hidden');
    return;
  }
  try {
    await apiSetSessionCategory(state.cur, id);
    s.category_id = id;
    $('chat-cat-sheet').classList.add('hidden');
    updateCatChip();
    renderCatSheet();
    toast('已移到「' + (categoryName(id) || '未分类') + '」');
  } catch (e) { toast('设置分类失败：' + e.message); }
}

async function openChatCatSheet() {
  if (!state.cur) return;
  $('chat-model-sheet').classList.add('hidden');   // 与模型 sheet 互斥
  await loadCategories();
  renderCatSheet();
  $('chat-cat-sheet').classList.remove('hidden');
}

function rowHtml(s, target, showCategory) {
  const working = state.working[s.id];
  const isWecom = target === 'wecom-list';
  // 「最近」分组里补一个所属分类标签（web 的 resolveRecentSessionCategoryLabel）
  const catName = showCategory
    ? ((s.category_id != null && categoryName(s.category_id)) || '未分类')
    : '';
  const canManage = !isWecom;   // 企微会话只读，不给分类入口
  const title = s.title || '（未命名会话）';
  const initial = String(title.trim()[0] || 'H').toUpperCase();
  const avatar = isWecom
    ? '<svg class="ico"><use href="#i-bot"/></svg>'
    : esc(initial);
  return '<div class="row" data-id="' + esc(s.id) + '" data-hermes="' + (isWecom ? '1' : '') + '">' +
    '<div class="row-avatar' + (isWecom ? ' is-wecom' : '') + '">' + avatar + '</div>' +
    '<div class="row-main">' +
      '<div class="row-top">' +
        '<span class="row-title">' + esc(title) + '</span>' +
        '<span class="row-time">' + fmtTime(s.last_active || s.ended_at || s.started_at) + '</span>' +
      '</div>' +
      '<div class="row-preview">' + esc(s.preview || '') + '</div>' +
      '<div class="row-meta">' +
        (working ? '<span class="chip working">● 运行中</span>' : '') +
        (catName ? '<span class="chip cat">' + esc(catName) + '</span>' : '') +
        (s.model ? '<span class="chip">' + esc(s.model) + '</span>' : '') +
        (s.message_count != null ? '<span class="chip">' + s.message_count + ' 条</span>' : '') +
        (s.source ? '<span class="chip">' + esc(s.source) + '</span>' : '') +
      '</div>' +
    '</div>' +
    (canManage ? '<button class="row-more" title="更多"><svg class="ico"><use href="#i-more"/></svg></button>' : '') +
  '</div>';
}

/**
 * 渲染会话列表。默认按 category 分组（未分类排最后），搜索结果/企微列表不分组。
 */
function renderSessions(list, target, emptyText, opts) {
  const items = list || state.sessions;
  const el = $(target || 'session-list');
  const grouped = !(opts && opts.flat);
  if (!items.length) {
    el.innerHTML = '<div class="empty">' + esc(emptyText || '还没有会话，点右下角 ＋ 新建') + '</div>';
    return;
  }

  let html = '';
  if (grouped) {
    const cats = state.categories || [];
    const buckets = [];
    const seen = new Set();

    // 「最近」快捷分组（复刻 web buildRecentSessionCategoryGroups：
    // 按更新时间倒序取 N 个，**不从真实分类里移除**——它是入口不是归属）。
    const recentCount = Math.min(100, Math.max(1, Number(localStorage.getItem('hm_recent_count') || 5)));
    const recent = items.slice()
      .sort((a, b) => (b.last_active || b.started_at || 0) - (a.last_active || a.started_at || 0))
      .slice(0, recentCount);
    if (recent.length) {
      buckets.push({ key: 'recent', name: '最近', items: recent, showCategory: true });
    }

    for (const c of cats) {
      const arr = items.filter((s) => s.category_id === c.id);
      if (arr.length) { buckets.push({ key: String(c.id), name: c.name, items: arr, categoryId: c.id }); seen.add(c.id); }
    }
    const rest = items.filter((s) => !seen.has(s.category_id));
    if (rest.length) buckets.push({ key: 'none', name: '未分类', items: rest });

    for (const b of buckets) {
      const collapsed = !!state.collapsed[b.key];
      html += '<div class="group-head" data-key="' + esc(b.key) + '">' +
        '<span class="group-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="group-name">' + esc(b.name) + '</span>' +
        '<span class="group-count">' + b.items.length + '</span>' +
        // 真实分类才给管理入口（「最近」是快捷入口、「未分类」不是分类实体）
        (b.categoryId ? '<button class="head-more" data-cat="' + b.categoryId + '" title="分类操作">⋯</button>' : '') +
      '</div>';
      if (!collapsed) html += b.items.map((s) => rowHtml(s, target, b.showCategory)).join('');
    }
  } else {
    html = items.map((s) => rowHtml(s, target)).join('');
  }
  el.innerHTML = html;

  el.querySelectorAll('.group-head').forEach((h) => {
    h.addEventListener('click', () => {
      const k = h.getAttribute('data-key');
      state.collapsed[k] = !state.collapsed[k];
      renderSessions(list, target, emptyText, opts);
    });
  });
  // 分组标题右侧「⋯」：重命名 / 删除该分类（不能冒泡去折叠分组）
  el.querySelectorAll('.group-head .head-more').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategoryActions(Number(b.getAttribute('data-cat')));
    });
  });

  el.querySelectorAll('.row').forEach((row) => {
    const sid = row.getAttribute('data-id');
    row.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.row-more')) return;   // ⋯ 自己处理
      if (Date.now() - (row._lp || 0) < 700) return;                   // 刚长按过，不打开会话
      const s = items.find((x) => x.id === sid) || {};
      openSession(sid, s.title || '', row.getAttribute('data-hermes') === '1', s.model || '');
    });
    const more = row.querySelector('.row-more');
    if (more) {
      more.addEventListener('click', (e) => { e.stopPropagation(); openSessionMenu(sid); });
      // 安卓惯例：长按行 = 打开行菜单（web 端是右键）
      bindLongPress(row, () => openSessionMenu(sid));
    }
  });
}

function touchSessionPreview(sid, text) {
  const s = state.sessions.find((x) => x.id === sid);
  if (s && text) {
    s.preview = String(text).replace(/\s+/g, ' ').slice(0, 80);
    if (state.view === 'sessions') renderSessions();
  }
}

/** 「停止」按钮只跟当前会话在不在跑有关。 */
function syncStopButton() {
  $('chat-stop').classList.toggle('hidden', !(state.cur && state.working[state.cur]));
}

/** 哪个列表在屏上就刷哪个（两个列表都显示「● 运行中」）。 */
function renderVisibleLists() {
  if (state.view === 'sessions') renderSessions();
  else if (state.view === 'wecom') renderWecomList();
}

function markWorking(sid, on) {
  if (!sid) return;
  if (on) state.working[sid] = true; else delete state.working[sid];
  syncStopButton();
  renderVisibleLists();
}

function toggleSearch(on) {
  state.searchMode = on;
  $('search-bar').classList.toggle('hidden', !on);
  if (on) { $('search-input').value = ''; $('search-input').focus(); }
  else loadSessions();
}

async function doSearch() {
  const q = $('search-input').value.trim();
  if (!q) { renderSessions(); return; }
  try {
    const res = await api('/api/studio/search/sessions?q=' + encodeURIComponent(q) + '&limit=40&profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
    // 搜索结果跨分类，平铺更符合「找东西」的直觉
    renderSessions(res.results || [], 'session-list', '没有匹配「' + q + '」的会话', { flat: true });
  } catch (e) {
    toast(e.message);
  }
}

/* ============================== 企微 ============================== */
function renderWecomList() {
  renderSessions(state.wecom, 'wecom-list', '暂无企微 Bot 会话', { flat: true });
}

async function loadWecom() {
  try {
    const res = await api('/api/studio/sessions/hermes?source=wecom_callback&limit=30&profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
    state.wecom = res.sessions || [];
    // 企微会话本身就是单一来源，不需要分组
    renderWecomList();
  } catch (e) {
    $('wecom-list').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

/* ============================== 聊天 ============================== */
function subLine(model) {
  return (model ? model + ' · ' : '') + state.profile;
}

async function openSession(id, title, hermes, model) {
  state.cur = id;
  state.curHermes = !!hermes;
  state.curTitle = title || '';
  state.curModel = model || '';
  state.msgs = [];
  state.cards = [];
  state.streaming = null;
  state.queued = [];            // 换会话清空队列，等 resumed 带回新的
  state.activeRunId = '';       // live 归组键按会话重置（resumed 会用历史 run_marker 顶上）
  state.lastHistoryRun = '';
  state.newSessionCategoryId = null;   // 打开的是已有会话，待定分类清空
  // 从已拉取的会话行里带出思考级别（网页版同字段 reasoning_effort）
  const row = (state.sessions || []).find((x) => x.id === id);
  state.reasoningEffort = (row && row.reasoning_effort) || '';
  state.curProvider = (row && row.provider) || '';   // 查上下文上限要用会话自身的模型
  state.contextTokens = 0;      // 换会话先清零，等 resumed / usage.updated 回填
  state.hermesUsage = { input: 0, output: 0 };   // 同上：企微会话的用量由 loadMessages 回填
  stopThinkingTimer();          // 计时归零，等 resumed 决定要不要起
  show('chat');
  atBottom = true;                // 打开会话先假定在底部
  updateJumpButton();
  $('chat-title').textContent = title || '（未命名会话）';
  updateChatSub(subLine(model));
  $('chat-cat-sheet').classList.add('hidden');
  updateCatChip();
  renderContextBar(0, 0);     // 打开会话先重置，数据到了再刷新
  renderCards();
  renderMsgs();
  await loadMessages();
  loadContextUsage();         // 用量与上限
  if (!hermes && state.socket && state.socket.connected) {
    try { state.socket.emit('resume', { session_id: id, profile: state.profile }); } catch (e) {}
  }
}

function closeChat() {
  state.cur = null;
  state.streaming = null;
  stopThinkingTimer();
  switchTab(state.curHermes ? 'wecom' : 'sessions');
}

function updateChatSub(text) { $('chat-sub').textContent = text; }

async function loadMessages() {
  const id = state.cur;
  if (!id) return;
  try {
    if (state.curHermes) {
      const res = await api('/api/studio/sessions/hermes/' + encodeURIComponent(id) + '?profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
      if (state.cur !== id) return;
      const msgs = (res.session && res.session.messages) || res.messages || [];
      state.msgs = normalizeHistory(msgs);
      // 用量退路：Hermes 会话的 in+out（web 版 ChatInput 对这类会话也是这个口径）。
      // 服务端 /sessions/:id/usage 只统计 studio 自己跑的 run，企微会话恒返回 0。
      const hs = res.session || {};
      state.hermesUsage = {
        input: Number(hs.input_tokens) || 0,
        output: Number(hs.output_tokens) || 0,
      };
      state.lastHistoryRun = lastRunMarker(state.msgs);
      renderMsgs();
      jumpToLatest();      // 打开会话即定位到最新消息
    } else {
      const res = await api('/api/studio/sessions/conversations/' + encodeURIComponent(id) + '/messages/paginated?offset=0&limit=300&profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
      if (state.cur !== id) return;
      state.msgs = normalizeHistory(res.messages || []);
      state.lastHistoryRun = lastRunMarker(state.msgs);
      renderMsgs();
      jumpToLatest();      // 打开会话即定位到最新消息
    }
  } catch (e) {
    if (state.cur === id) toast('加载消息失败：' + e.message);
  }
}

/** 把 ContentBlock[] 拆成 { text, images }。 */
function parseInputBlocks(raw) {
  if (Array.isArray(raw.input) || (raw.input && typeof raw.input === 'object')) {
    const arr = Array.isArray(raw.input) ? raw.input : [raw.input];
    const texts = [];
    const imgs = [];
    for (const b of arr) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) texts.push(b.text);
      else if (b.type === 'image') imgs.push({ name: b.name, path: b.path, media_type: b.media_type });
      else if (b.type === 'file') texts.push('[附件 ' + (b.name || '') + ']');
    }
    return { text: texts.join('\n'), images: imgs.length ? imgs : null };
  }
  return { text: String(raw.input || ''), images: null };
}

function normMsg(m) {
  const rawContent = m.display_content || m.content || '';
  // 入站消息可能带 ContentBlock 数组（input 为结构化数据时）
  if (rawContent && Array.isArray(rawContent)) {
    const parsed = parseInputBlocks({ input: rawContent });
    return {
      key: 'm' + (m.id != null ? m.id : Math.random().toString(36).slice(2)),
      role: String(m.display_role || m.role || 'assistant'),
      content: parsed.text,
      images: parsed.images,
      reasoning: m.reasoning || m.reasoning_content || '',
      tool: m.tool_name || '',
      ts: m.timestamp,
    };
  }
  const rawRole = String(m.display_role || m.role || 'assistant');
  const content = rawContent;
  const toolName = m.tool_name || '';
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];

  // 「发起工具调用」这类消息：role=assistant、content 为空、finish_reason=tool_calls，
  // 真正的意图在 tool_calls[] 里。不处理就会渲染成一个空气泡。
  if (rawRole === 'assistant' && !String(content).trim() && !toolName && calls.length) {
    const fn = (calls[0] && (calls[0].function || calls[0])) || {};
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || '');
    return {
      key: 'm' + (m.id != null ? m.id : Math.random().toString(36).slice(2)),
      role: 'tool',
      content: args,
      reasoning: m.reasoning || m.reasoning_content || '',
      tool: fn.name || 'tool',
      toolCallId: calls[0].id || '',
      announce: true,          // 公告行：后面有同 id 的结果行时会被合并掉
      runMarker: m.run_marker || '',
      status: 'done',
      ts: m.timestamp,
    };
  }

  return {
    key: 'm' + (m.id != null ? m.id : Math.random().toString(36).slice(2)),
    role: rawRole,
    content,
    reasoning: m.reasoning || m.reasoning_content || '',
    tool: toolName,
    toolCallId: m.tool_call_id || '',
    runMarker: m.run_marker || '',
    status: 'done',
    ts: m.timestamp,
  };
}

/**
 * 给没有 run_marker 的历史工具行补一个「合成轮次」键。
 *
 * 企微 Bot 等 hermes-history 会话的消息里 run_marker 一律是 null（实测整个语料都是），
 * 于是所有工具行都各占一行、无从整合。这里以**用户消息**为界划轮次——服务端的一次 run
 * 就是一条用户消息引发的整段处理，所以合成键与 studio 会话的 run_marker 语义等价：
 * 同一轮里的多个工具调用/多段说明文字都算同一组。
 */
function assignSynthRuns(rows) {
  let seq = 0;
  let cur = '';
  for (const m of rows) {
    if (m.role === 'user') { seq += 1; cur = 'hist' + seq; }
    else if (!cur) cur = 'hist0';   // 窗口开头（用户消息之前）的工具行
    if (m.role === 'tool') m.synthRun = cur;
  }
}

/** 历史消息 → 内部行：先补合成轮次键，再合并「公告行 + 结果行」。 */
function normalizeHistory(raw) {
  const rows = (raw || []).map(normMsg);
  assignSynthRuns(rows);
  return mergeToolAnnouncements(rows);
}
/**
 * 合并历史里成对的工具行。
 * 服务端把一次工具调用存成两行：assistant 的 tool_calls 公告行（content 空）+ tool 结果行。
 * web 端 `mapHermesMessages` 用 toolCallId 把两者并成一行（见 chat.ts 的 placeholder 逻辑），
 * 不合并的话同一轮工具调用在重开会话后计数翻倍（live 3 条 → 历史 6 条），
 * 与「整合行」里的数字对不上。
 */
function mergeToolAnnouncements(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.role === 'tool' && m.announce && m.toolCallId) {
      const merged = msgs.some((x) =>
        x !== m && x.role === 'tool' && !x.announce
        && String(x.toolCallId || '') === String(m.toolCallId)
        && String(x.runMarker || '') === String(m.runMarker || ''));
      if (merged) continue;   // 保留信息更全的结果行
    }
    out.push(m);
  }
  return out;
}

function renderMsgs() {
  const el = $('msg-list');
  if (!state.msgs.length && !state.streaming && !state.queued.length) {
    el.innerHTML = '<div class="empty">还没有消息，发第一条吧</div>';
    return;
  }
  // 同轮次的工具调用合并成一行（复刻 web）
  const grouped = groupToolsByRun(state.msgs);
  el.innerHTML = grouped.map((m) => (m.role === 'tool-run' ? toolRunHtml(m) : msgHtml(m))).join('')
    + (state.streaming ? streamHtml() : '')
    + (state.queued.length ? queuedHtml() : '');
  bindMsgLinks(el);
  // 排队消息旁的 ⬆️ 插入 / ✕ 取消
  el.querySelectorAll('.queue-send-btn').forEach((b) => {
    b.addEventListener('click', () => {
      sendQueuedNow(b.getAttribute('data-qid'));
    });
  });
  el.querySelectorAll('.queue-cancel-btn').forEach((b) => {
    b.addEventListener('click', () => {
      cancelQueued(b.getAttribute('data-qid'));
    });
  });
  // 进行中的思考条：点一下展开/收起全文（收起时只占一行）
  const rline = el.querySelector('#reasoning-line');
  if (rline) rline.addEventListener('click', () => {
    state.expandedReasoning = !state.expandedReasoning;
    renderMsgs();
  });
  // 工具轮次行：点一下展开/收起
  el.querySelectorAll('.tool-run-row').forEach((b) => {
    b.addEventListener('click', () => {
      const rid = b.getAttribute('data-rid');
      state.expandedRuns[rid] = !state.expandedRuns[rid];
      renderMsgs();
    });
  });
  scrollBottom();
}

/**
 * 按 run_marker 把**同一轮次**的工具调用合并成一条。
 * 复刻 web 端 `components/hermes/chat/tool-run-grouping.ts` 的
 * `groupCompletedToolsByRun()`：同 run 的工具收进一个条目，渲染成一行。
 */
function groupToolsByRun(msgs) {
  const byRun = new Map();
  // 归组键：优先服务端的 run_marker；历史会话（企微等）没有它，用合成轮次键
  const runKeyOf = (m) => String(m.runMarker || m.synthRun || '').trim();
  for (const m of msgs) {
    if (m.role !== 'tool' || m.isStreamingTool) continue;
    const rid = runKeyOf(m);
    if (!rid) continue;
    if (!byRun.has(rid)) byRun.set(rid, []);
    byRun.get(rid).push(m);
  }
  if (!byRun.size) return msgs;

  const emitted = new Set();
  const out = [];
  for (const m of msgs) {
    const rid = m.role === 'tool' && !m.isStreamingTool ? runKeyOf(m) : '';
    if (!rid || !byRun.has(rid)) { out.push(m); continue; }
    if (emitted.has(rid)) continue;
    emitted.add(rid);
    const tools = byRun.get(rid);
    out.push({ key: 'run:' + rid, role: 'tool-run', runMarker: rid, tools: tools, ts: tools[0].ts });
  }
  return out;
}

/** 工具行摘要文案（与 web ToolRunSummary 一致：前 3 个名字 + N）。 */
function toolRunNames(tools) {
  const names = [];
  for (const t of tools) {
    const n = t.tool;
    if (n && names.indexOf(n) === -1) names.push(n);
  }
  const visible = names.slice(0, 3).join(' · ');
  return names.length > 3 ? visible + ' · +' + (names.length - 3) : visible;
}

/** 一整轮工具调用 = 一行（可点开看逐个）。 */
function toolRunHtml(m) {
  const tools = m.tools || [];
  const rid = m.runMarker;
  const expanded = !!state.expandedRuns[rid];
  const hasError = tools.some((t) => t.status === 'error');
  const running = tools.filter((t) => t.status === 'running').length;
  const names = toolRunNames(tools);
  const body = expanded
    ? '<div class="tool-run-expand">' + tools.map((t) =>
        '<div class="tool-row">' +
          '<span class="t-name">' + esc(t.tool || 'tool') + '</span>' +
          (t.status === 'running' ? '<span class="t-state run">运行中</span>'
            : (t.status === 'error' ? '<span class="t-state err">失败</span>' : '')) +
          '<span class="t-prev">' + esc(String(t.content || '').replace(/\s+/g, ' ').slice(0, 160)) + '</span>' +
        '</div>').join('') + '</div>'
    : '';
  return '<div class="msg assistant tool-run-wrap">' +
    '<div class="msg-line">' + botAvatarHtml() +
      '<button class="tool-run-row' + (hasError ? ' has-error' : '') + '" data-rid="' + esc(rid) + '">' +
        '<span class="tool-run-chevron">' + (expanded ? '▾' : '▸') + '</span>' +
        '<span class="tool-run-count">' + tools.length + ' 次工具调用</span>' +
        (running ? '<span class="tool-run-running">运行中</span>' : '') +
        (names ? '<span class="tool-run-names">' + esc(names) + '</span>' : '') +
        (hasError ? '<span class="tool-run-badge">错误</span>' : '') +
      '</button>' +
    '</div>' +
    body +
  '</div>';
}

/** 排队消息（followed 队列）渲染：虚线框 + ⬆️ 插入 / ✕ 取消。 */
function queuedHtml() {
  if (!state.queued.length) return '';
  const inserting = state.queueInsertingId;
  const items = state.queued.map((q) => {
    const isInserting = inserting && String(inserting) === String(q.id);
    return '<div class="msg user queued-item' + (isInserting ? ' inserting' : '') + '">' +
      '<div class="msg-line">' + userAvatarHtml() +
        '<div class="bubble">' + imagesHtml(q.images) + (q.content ? wrapOverflow(md(q.content)) : '') + '</div>' +
        '<button class="queue-send-btn" data-qid="' + esc(q.id) + '" title="插入会话">⬆️</button>' +
        '<button class="queue-cancel-btn" data-qid="' + esc(q.id) + '" title="取消">✕</button>' +
      '</div>' +
      '<div class="msg-time">' + (isInserting ? '正在插入…' : '排队中 · ⬆️ 立即插入') + '</div>' +
    '</div>';
  }).join('');
  return '<div class="queue-section">' +
    '<div class="queue-title">⏸ 排队中（' + state.queued.length + '）</div>' +
    items +
  '</div>';
}

/**
 * 点排队消息旁的 ⬆️：让服务端把这条**在安全边界插入当前会话**执行。
 *
 * ⚠️ 不能用 emit('run')！那是"发起一次新运行"，会另起一条会话/重复发送（用户报的 bug）。
 * 服务端专门提供了 `insert_queued_run { session_id, queue_id }`
 * （chat-run.ts 里 requestQueuedRunInsertion），插入结果由服务端通过
 * `run.queued` / `run.queue_insertion.updated` 回推，本地不擅自改队列。
 */
function sendQueuedNow(queueId) {
  const q = state.queued.find((x) => String(x.id) === String(queueId));
  if (!q || !state.cur) return;
  if (!state.socket || !state.socket.connected) {
    toast('连接已断开，正在重连…');
    connectSocket();
    return;
  }
  try {
    state.socket.emit('insert_queued_run', { session_id: state.cur, queue_id: queueId });
    toast('已请求插入会话…');
  } catch (e) {
    toast('插入失败：' + (e.message || ''));
  }
}

/** 取消一条排队消息（服务端 cancel_queued_run）。 */
function cancelQueued(queueId) {
  if (!state.cur || !state.socket || !state.socket.connected) return;
  try {
    state.socket.emit('cancel_queued_run', { session_id: state.cur, queue_id: queueId });
    // 服务端会回推 run.queued 带新队列；本地先乐观移除
    state.queued = state.queued.filter((x) => String(x.id) !== String(queueId));
    renderMsgs();
  } catch (e) {
    toast('取消失败：' + (e.message || ''));
  }
}

/** 消息里的附件 HTML：图片出图，其他文件出下载卡。 */
function attachmentsHtml(items) {
  if (!items || !items.length) return '';
  return items.map((a) => {
    const type = String(a.media_type || a.type || '');
    const isImg = a.kind ? a.kind === 'image' : /^image\//.test(type);
    if (isImg) {
      const src = a.path ? imageSrcFor(a.path) : (a.localUrl || a.previewUrl || '');
      if (!src) return '';
      return '<div class="imgwrap"><img class="chat-img" alt="' + esc(a.name || '') + '" src="' + esc(src) + '"></div>';
    }
    const href = a.path ? fileDownloadUrl(a.path, a.name) : '';
    if (!href) return '';
    return '<a class="file-card" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      '<span class="fc-ico">' + fileIcon(a.name) + '</span>' +
      '<span class="fc-main"><span class="fc-name">' + esc(a.name || '文件') + '</span>' +
      '<span class="fc-meta">' + esc(type || '文件') + '</span></span>' +
      '<span class="fc-dl">下载</span></a>';
  }).join('');
}
/** 旧名兼容（排队区/消息渲染处原先叫 imagesHtml）。 */
const imagesHtml = attachmentsHtml;

/** 思考结束后的处理：'hide' = 直接隐藏（不占位，默认）｜'line' = 单行折叠条 */
const DONE_REASONING = 'hide';

function msgHtml(m) {
  if (m.role === 'tool' || m.role === 'command' || m.tool) {
    // 工具行与助手消息同列：左侧占位对齐头像宽度
    return '<div class="msg assistant">' +
      '<div class="msg-line">' + botAvatarHtml() +
        '<div class="tool-row"><span class="t-name">' + esc(m.tool || m.role) + '</span>' +
          '<span class="t-prev">' + esc(String(m.content || '').replace(/\s+/g, ' ').slice(0, 160)) + '</span>' +
        '</div>' +
      '</div>' +
      (m.ts ? '<div class="msg-time">' + fmtTime(m.ts) + '</div>' : '') +
    '</div>';
  }
  const side = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'assistant');
  const imgs = imagesHtml(m.images);
  const bodyHtml = String(m.content == null ? '' : m.content).trim() ? wrapOverflow(md(m.content)) : '';
  /**
   * 思考过程的显示策略（用户 2026-10-18 反馈：新版每条思考都留一块占位，一屏全是「▸ 思考过程」）：
   * · 思考**一结束就隐藏**，不再占位 —— 默认行为（DONE_REASONING = 'hide'）。
   * · 进行中的思考只占**一行**，见 streamHtml() / reasoningLineHtml()。
   * 若哪天想恢复"结束后仍能点开看"，把这里改成 'line' 即可（渲染成单行折叠条）。
   */
  let extra = '';
  if (m.reasoning && DONE_REASONING === 'line') {
    extra = '<details class="reasoning"><summary>思考过程</summary><div class="reasoning-body">' + esc(m.reasoning) + '</div></details>';
  }
  // 没有正文也没有图片（典型：思考结束后被"恢复"出来的空 assistant 消息）→ 整条不渲染。
  // 否则会留下「头像 + 空气泡 + 时间」这一行纯占位（用户报的第二个问题）。
  if (!bodyHtml && !imgs) return '';
  // system 消息不带头像（居中提示条）
  const lineInner = side === 'system'
    ? bodyHtml
    : (side === 'user' ? userAvatarHtml() : botAvatarHtml()) +
      '<div class="bubble">' + (imgs + bodyHtml) + '</div>';
  return extra + '<div class="msg ' + side + '">' +
    '<div class="msg-line">' + lineInner + '</div>' +
    (m.ts ? '<div class="msg-time">' + fmtTime(m.ts) + '</div>' : '') +
  '</div>';
}

/** 思考文本压成一行尾巴：空白折叠、只留尾部 80 字，超长加省略号。 */
function reasoningTail(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 80 ? '…' + s.slice(-80) : s;
}

/**
 * 进行中的思考条：**只占一行**（用户 2026-10-18 要求）。
 * 点一下展开全文（面板 max-height 40vh 可滚动），再点收起。
 * 思考结束 → 这条直接消失（不占位），所以永远最多只有一行思考 UI。
 */
function reasoningLineHtml(text) {
  const open = !!state.expandedReasoning;
  return '<div class="reasoning-line' + (open ? ' open' : '') + '" id="reasoning-line">' +
      '<span class="r-label">思考中</span>' +
      '<span class="r-text" id="reasoning-tail">' + esc(reasoningTail(text)) + '</span>' +
      '<span class="r-caret">' + (open ? '▾' : '▸') + '</span>' +
    '</div>' +
    '<div class="reasoning-panel' + (open ? ' open' : '') + '" id="reasoning-panel">' +
      '<div class="reasoning-body" id="reasoning-body">' + esc(text) + '</div>' +
    '</div>';
}

function streamHtml() {
  const st = state.streaming;
  const hasText = !!(st.text && String(st.text).trim());
  // 没有正文时不画空气泡（只留一个闪烁光标，见 .bubble.caret-only）
  return '<div class="msg assistant">' +
    (st.reasoning && st.thinking ? reasoningLineHtml(st.reasoning) : '') +
    '<div class="msg-line">' + botAvatarHtml() +
      '<div class="bubble caret' + (hasText ? '' : ' caret-only') + '" id="stream-bubble">' +
        (hasText ? wrapOverflow(md(st.text)) : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

function startStream(sid) {
  if (state.streaming && state.streaming.sid === sid) return;
  // 保存上一条未结束的流：只落有正文的（思考结束就隐藏，不单独落一条空消息）
  if (state.streaming && String(state.streaming.text || '').trim()) {
    state.msgs.push({ key: 's' + Date.now(), role: 'assistant', content: state.streaming.text, reasoning: state.streaming.reasoning, ts: Date.now() / 1000 });
  }
  state.streaming = { sid, text: '', reasoning: '', thinking: false };
  state.expandedReasoning = false;   // 新的一轮思考从收起态开始（只占一行）
  renderMsgs();
}

function paintStream() {
  const st = state.streaming;
  if (!st) return;
  // 思考条只在"正在思考"时存在：出现/消失各整块重绘一次，之后的增量只改文本（不重排整列）。
  const wantLine = !!(st.reasoning && st.thinking);
  const hasLine = !!$('reasoning-line');
  if (wantLine !== hasLine) { renderMsgs(); return; }
  const b = $('stream-bubble');
  if (!b) { renderMsgs(); return; }
  const hasText = !!(st.text && String(st.text).trim());
  b.innerHTML = hasText ? wrapOverflow(md(st.text)) : '';
  b.classList.toggle('caret-only', !hasText);
  const tail = $('reasoning-tail');
  if (tail) tail.textContent = reasoningTail(st.reasoning);
  if (state.expandedReasoning) {
    const body = $('reasoning-body');
    if (body) body.textContent = st.reasoning;
  }
  // 用户上滑翻历史时绝不打断；atBottom=true 时才跟随（沿用上次修复的语义）
  scrollBottom();
}

function finishStream(finalText, error) {
  const st = state.streaming;
  const text = finalText != null && finalText.length ? finalText : (st ? st.text : '');
  const body = String(text || '').trim();
  state.expandedReasoning = false;
  // 只落有正文的消息：思考结束后的空文本不再变成一条空消息（那就是用户看到的那排空气泡占位）。
  if (body || error) {
    state.msgs.push({
      key: 'f' + Date.now(), role: 'assistant',
      content: body + (error ? '\n\n> ⚠ ' + error : ''),
      reasoning: st ? st.reasoning : '', ts: Date.now() / 1000,
    });
  }
  state.streaming = null;
  renderMsgs();
}

function addMsg(m) {
  state.msgs.push({
    key: 'u' + Date.now() + Math.random().toString(36).slice(2, 5),
    role: m.role, content: m.content,
    images: m.images || null,
    ts: m.ts || Date.now() / 1000,
  });
  renderMsgs();
}

/** 历史消息里最后一条带 run_marker 的行 —— 就是「当前正在跑的那一轮」。 */
function lastRunMarker(msgs) {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const rid = String(msgs[i].runMarker || '').trim();
    if (rid) return rid;
  }
  return '';
}

/**
 * live 工具行的归组键。
 * socket 的 tool.* 事件只带 `run_id`（bridge 的 run id），而历史消息里的 `run_marker`
 * 是服务端另生成的（`cli_run_*` / `cli_resume_*`），两者不相等。所以优先用本会话已认定的
 * `state.activeRunId`（中途打开会话时来自历史消息），再退回事件自带的 run_id。
 */
function liveRunKey(ev) {
  const own = String((ev && (ev.run_marker || ev.run_id)) || '').trim();
  return state.activeRunId || own || '';
}

/**
 * 实时工具事件 → 写入/更新一条工具行：同 (run, tool_call_id) 只有一条，
 * started 建行（运行中），completed/failed 就地改状态。
 * 复刻 web 的 `handleToolStartedEvent` / `handleToolCompletedEvent`（按 tool_call_id upsert）。
 */
function upsertLiveTool(ev, phase) {
  const name = ev.tool || ev.name || 'tool';
  const run = liveRunKey(ev);
  const callId = String(ev.tool_call_id || '');
  const prev = String(phase === 'error' ? (ev.error || ev.preview || '') : (ev.preview || ev.output || ''))
    .replace(/\s+/g, ' ').slice(0, 300);

  let row = null;
  for (let i = state.msgs.length - 1; i >= 0; i -= 1) {
    const m = state.msgs[i];
    if (m.role !== 'tool' || String(m.runMarker || '') !== run) continue;
    if (callId) {
      if (String(m.toolCallId || '') === callId) { row = m; break; }
    } else if (!m.toolCallId && m.tool === name && m.status === 'running') {
      row = m; break;   // 老事件不带 call id：只认同轮次里还挂着的同名行
    }
  }

  if (row) {
    row.tool = name || row.tool;
    row.toolCallId = row.toolCallId || callId;
    row.status = phase;
    if (prev) row.content = prev;
  } else {
    state.msgs.push({
      key: 't' + Date.now() + Math.random().toString(36).slice(2, 5),
      role: 'tool', tool: name, toolCallId: callId, content: prev,
      runMarker: run, status: phase, live: true, ts: Date.now() / 1000,
    });
  }
  renderMsgs();
}

/** 一轮结束时给还挂着「运行中」的 live 行收尾（复刻 web `settleRunningTools`）。 */
function settleLiveTools(phase) {
  let dirty = false;
  for (const m of state.msgs) {
    if (m.role === 'tool' && m.live && m.status === 'running') { m.status = phase; dirty = true; }
  }
  if (dirty) renderMsgs();
}

function addToolRow(name, prev) {
  state.msgs.push({ key: 't' + Date.now() + Math.random().toString(36).slice(2, 5), role: 'tool', tool: name, content: prev || '', ts: Date.now() / 1000 });
  renderMsgs();
}

/**
 * 滚动到底部。
 * force=true 无条件滚（打开会话、自己发消息时用）。
 * 布局会因为图片/字体延迟加载而变化，所以跨几帧重试兜底。
 *
 * 滚动状态追踪：用户是否停在最底部。
 * atBottom=false 时，流式输出/新消息**不再自动拉到底部**，让用户能安静翻历史；
 * 同时浮出「⬇️ 回到底部」按钮。atBottom=true 时自动跟随并隐藏按钮。
 */
let atBottom = true;
const BOTTOM_TOLERANCE = 24;   // 距底 24px 内视为「到底」

function isAtBottom() {
  const el = $('msg-list');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE;
}

function updateJumpButton() {
  const btn = $('btn-jump-bottom');
  if (!btn) return;
  btn.classList.toggle('hidden', atBottom);
}

function scrollBottom(force) {
  const el = $('msg-list');
  if (!el) return;
  const go = () => {
    el.scrollTop = el.scrollHeight;
    atBottom = true;
    updateJumpButton();
  };
  if (force) {
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(() => {
        go();
        setTimeout(go, 120);
      });
    });
    return;
  }
  // 非 force：只有用户本来就停在最底部才跟随，绝不打断翻历史
  if (atBottom) go();
}

/** 打开会话时强制定位到最新（跨帧重试兜底图片/字体加载）。 */
function jumpToLatest() {
  scrollBottom(true);
}

function bindMsgLinks(el) {
  el.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      openLink(href);
    });
  });
}

/**
 * 打开消息里的链接。
 * 复用 web 端 `getFileDownloadUrl()` 的思路：
 * - http(s)/ftp → 交系统浏览器/下载器
 * - **其他（本地文件路径）→ 走 `/api/studio/files/download?path=&token=`**
 *   （web 端就是这么把「服务器上的文件」变成可下载 URL 的；之前只认 http 前缀，
 *    所以发出来的 APK 这类本地路径链接点了没反应）
 */
function openLink(href) {
  if (!href) return;
  const raw = String(href).trim();
  if (!raw) return;
  const url = /^(https?:|ftp:)/i.test(raw) ? raw : fileDownloadUrl(raw);
  if (!url) return;
  if (window.Android && window.Android.openUrl) {
    try { window.Android.openUrl(url); return; } catch (err) {}
  }
  try { window.open(url, '_blank'); } catch (err) {}
}

/** 与 web 端 getFileDownloadUrl 同形：本地路径 → 可下载 URL（token 放 query）。 */
function fileDownloadUrl(path, name) {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const base = state.base.replace(/\/$/, '');
  const params = new URLSearchParams({ path: String(path) });
  if (name) params.set('name', name);
  params.set('profile', state.profile);
  if (state.token) params.set('token', state.token);
  return base + '/api/studio/files/download?' + params.toString();
}

/* ============================== 附件（照片 / 拍摄 / 文件） ============================== */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 单张图片上限（服务端硬限 50MB）
const MAX_FILE_BYTES = 50 * 1024 * 1024;    // 其他文件上限

/** 当前待发送的附件：[{id,kind:'image'|'file',name,type,size,file,previewUrl,uploaded,err}] */
let pending = [];

function fileSizeText(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

/** 文件类型图标（用 emoji，不依赖图标资源）。 */
function fileIcon(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'bmp'].includes(ext)) return '🖼';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜';
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return '🎵';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'sh', 'json', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'md', 'txt'].includes(ext)) return '📄';
  return '📎';
}

/** 按文件名推断 MIME（相册/相机返回的 File 有时 type 为空）。 */
function guessMime(name, fallback) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', bmp: 'image/bmp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', csv: 'text/csv', zip: 'application/zip',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    mp4: 'video/mp4', mov: 'video/quicktime',
  };
  return map[ext] || fallback || 'application/octet-stream';
}

function renderAttachments() {
  const bar = $('attach-bar');
  const list = $('attach-list');
  if (!pending.length) {
    bar.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  list.innerHTML = pending.map((a) => {
    const status = a.err ? '<div class="up err">失败</div>'
      : (a.uploaded ? '' : '<div class="up">待上传</div>');
    const isImg = a.kind === 'image';
    const inner = isImg
      ? '<img alt="" src="' + esc(a.previewUrl) + '">'
      : '<div class="af-ico">' + fileIcon(a.name) + '</div>';
    return '<div class="att' + (isImg ? '' : ' att-file') + '">' + inner + status +
      (isImg ? '' : '<div class="af-name">' + esc(a.name) + '</div>' +
        '<div class="af-size">' + fileSizeText(a.size) + '</div>') +
      '<button class="rm" data-id="' + esc(a.id) + '" title="移除">×</button>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.rm').forEach((b) => {
    b.addEventListener('click', () => {
      removeAttachment(b.getAttribute('data-id'));
    });
  });
}

function removeAttachment(id) {
  const i = pending.findIndex((a) => a.id === id);
  if (i === -1) return;
  const a = pending[i];
  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  pending.splice(i, 1);
  renderAttachments();
}

/** 已在 buildAndSend 里等待上传；此处保留为空操作占位。 */
function clearPendingRefs() { /* no-op */ }

/**
 * 从剪贴板取文件（复刻 web 端 utils/clipboard-files.ts）。
 * 图片统一重命名为 pasted-<时间戳>[-N].<ext>，与 web 一致。
 */
function extractClipboardFiles(clipboardData) {
  if (!clipboardData) return [];
  const itemFiles = Array.prototype.slice.call(clipboardData.items || [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f) => !!f);
  const files = itemFiles.length ? itemFiles
    : Array.prototype.slice.call(clipboardData.files || []);
  const pastedAt = Date.now();
  return files.map((file, index) => {
    if (!/^image\//.test(file.type)) return file;
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9.+-]/gi, '');
    const suffix = index > 0 ? '-' + (index + 1) : '';
    return new File([file], 'pasted-' + pastedAt + suffix + '.' + ext,
      { type: file.type, lastModified: file.lastModified });
  });
}

/** data URL → File（原生剪贴板回传用）。 */
function dataUrlToFile(dataUrl, name) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  const type = m[1];
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name || ('pasted-' + Date.now() + '.png'), { type: type });
}

/** 粘贴事件：优先用 clipboardData 里的文件，取不到再问原生剪贴板。 */
async function handlePaste(e) {
  const files = extractClipboardFiles(e.clipboardData);
  if (files.length) {
    e.preventDefault();
    onFilesPicked(files);
    return;
  }
  // Android WebView 的 paste 事件常常不带图片文件 → 走原生剪贴板
  if (window.Android && window.Android.getClipboardImage) {
    let raw = '';
    try { raw = window.Android.getClipboardImage(); } catch (err) { raw = ''; }
    if (raw) {
      const info = safeJson(raw, null);
      if (info && info.dataUrl) {
        const f = dataUrlToFile(info.dataUrl, info.name);
        if (f) {
          e.preventDefault();
          onFilesPicked([f]);
          return;
        }
      }
    }
  }
}

function pickImages() {
  triggerPicker('photo');
}

/** 打开附件面板（Ekko 式：照片 / 拍摄 / 文件）。 */
function openAttachPanel() {
  const p = $('attach-panel');
  if (p) p.classList.remove('hidden');
}
function closeAttachPanel() {
  const p = $('attach-panel');
  if (p) p.classList.add('hidden');
}

/** 按类型触发对应的 <input type=file>（实际弹窗由原生 onShowFileChooser 接管）。 */
function triggerPicker(kind) {
  closeAttachPanel();
  const id = kind === 'camera' ? 'pick-camera' : (kind === 'file' ? 'pick-file' : 'pick-photo');
  const el = $(id);
  if (!el) return;
  el.value = '';
  el.click();
}

/**
 * 收下用户选好的文件（照片/相机/文件共用）。
 * Ekko 版语义：图片是 image block，其他文件是 file block（见 ContentBlock）。
 */
function onFilesPicked(fileList) {
  const files = Array.prototype.slice.call(fileList || []);
  let skipped = 0;
  for (const f of files) {
    const type = guessMime(f.name, f.type);
    const isImg = /^image\//.test(type);
    const limit = isImg ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!f.size || f.size > limit) { skipped++; continue; }
    pending.push({
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      kind: isImg ? 'image' : 'file',
      name: f.name || ((isImg ? 'image-' : 'file-') + Date.now()),
      type: type,
      size: f.size,
      file: f,
      previewUrl: isImg ? URL.createObjectURL(f) : '',
      uploaded: null,
      err: null,
    });
  }
  if (skipped) {
    toast('已跳过 ' + skipped + ' 个文件（图片 ≤20MB，其他 ≤50MB）');
  }
  if (pending.length) {
    renderAttachments();
    // 真正上传在 buildAndSend 里做（那时才有目标会话），这里只出预览
  }
}

/**
 * 图片 URL 还原：服务端返回的是文件 path，需拼成可取回的 URL。
 * 实测 /api/studio/files/preview 对上传目录返回 400，/download 可用 → 用 download。
 * 必须把 token 放进 query：WebView 里 <img> 的 GET 请求不会自动带 Authorization 头。
 */
function imageSrcFor(path) {
  return fileDownloadUrl(path);
}

/* ============================== 上下文用量 ============================== */
/** 数字缩写：与 web 版 formatTokens 一致（1.2k / 1.2M）。 */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (!Number.isFinite(v)) return '0';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

function renderContextBar(used, limit) {
  const text = $('ctx-text');
  const fill = $('ctx-fill');
  if (!text || !fill) return;
  // 有手选上限时覆盖服务端值
  const effective = getEffectiveLimit(limit);
  if (!effective || effective <= 0) {
    text.className = 'ctx-text';
    text.textContent = used > 0
      ? '上下文 ' + fmtTokens(used) + ' · 上限未知'
      : '上下文 —';
    fill.style.width = '0%';
    fill.className = 'ctx-fill';
    return;
  }
  const pct = Math.min(Math.max((used / effective) * 100, 0), 100);
  // 阈值与 web 版一致：>60% warn，>80% danger
  const level = pct > 80 ? 'danger' : (pct > 60 ? 'warn' : '');
  text.className = 'ctx-text' + (level ? ' ' + level : '');
  // 手选上限时加个标记，提示这是覆盖值不是服务端
  const override = !!state.ctxLimitOverride;
  text.textContent = '上下文 ' + fmtTokens(used) + ' / ' + fmtTokens(effective)
    + ' · 余 ' + fmtTokens(Math.max(0, effective - used))
    + ' (' + pct.toFixed(0) + '%)' + (override ? ' ▾' : '');
  fill.className = 'ctx-fill' + (level ? ' ' + level : '');
  fill.style.width = pct + '%';
}

/** 生效的上限：手选覆盖 > 服务端 context-length > 0（未知）。 */
function getEffectiveLimit(serverLimit) {
  if (state.ctxLimitOverride) {
    const v = Number(state.ctxLimitOverride);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return serverLimit || 0;
}

/** 点上下文区域：在两个档位间循环切换上限覆盖。 */
function cycleContextLimit() {
  const cur = state.ctxLimitOverride;
  let next;
  if (!cur) next = String(CONTEXT_LIMIT_CHOICES[0]);
  else if (cur === String(CONTEXT_LIMIT_CHOICES[0])) next = String(CONTEXT_LIMIT_CHOICES[1]);
  else if (cur === String(CONTEXT_LIMIT_CHOICES[1])) next = '';   // 回到服务端默认
  else next = String(CONTEXT_LIMIT_CHOICES[0]);
  state.ctxLimitOverride = next;
  if (next) localStorage.setItem('hm_ctx_limit', next);
  else localStorage.removeItem('hm_ctx_limit');
  toast('上下文上限：' + (next ? fmtTokens(next) : '服务端默认'));
  loadContextUsage();   // 立即用新上限重算
}

/**
 * 拉上下文用量与上限。
 * 用量：/api/studio/sessions/:id/usage（input+output+cache_read，与 web 版口径一致）
 * 上限：手选覆盖优先，否则 /api/studio/sessions/context-length
 */
/**
 * 上下文用量 + 上限。
 *
 * **用量口径必须与 web 版一致**：web 优先用服务端的 `contextTokens`
 * （socket `resumed` / `usage.updated` 事件带回），它才是「当前上下文占了多少」；
 * 退路才是 `input + output`（**不含 cache_read**）。
 * 早期版本用 REST /usage 把 input+output+cache_read 全加起来，那是**累计计费用量**，
 * 会明显偏大（实测 431.2k vs web 273.0k）——不要再那样算。
 *
 * **企微（hermes-history）会话**：既没有 socket 状态（不发 `resume`），
 * `/api/studio/sessions/:id/usage` 也查不到（studio 库只记自己跑的 run，实测恒 0/0），
 * 所以用量取 `GET /api/studio/sessions/hermes/:id` 的 `input_tokens+output_tokens`
 * —— Hermes state.db 的会话累计，与 web 端对这类会话的 fallback 同口径。
 */
async function loadContextUsage() {
  const id = state.cur;
  if (!id) return;
  // 1) 上限
  let limit = 0;
  try {
    // ⚠️ **不传 model/provider**，让服务端按会话自己解析上限。
    // 传参极易踩 provider 键名不匹配的坑并静默回退到 Hermes 内置默认值：
    //   provider=workbuddy         → 256000  （内置默认，错！）
    //   provider=custom:workbuddy  → 1048576 （正确，需带 custom: 前缀）
    //   不传参数                    → 1000000 （服务端按会话解析，最稳）
    const params = new URLSearchParams({ profile: state.profile });
    const len = await api('/api/studio/sessions/context-length?' + params.toString(),
      { noProfileHeader: true }).catch(() => null);
    if (state.cur !== id) return;
    limit = len && Number(len.context_length) > 0 ? Number(len.context_length) : 0;
  } catch (e) { /* 上限拿不到也能显示用量 */ }

  // 2) 用量：优先 socket 带的 contextTokens
  let used = Number(state.contextTokens) || 0;
  // 2b) 企微等 hermes-history 会话不走 socket、也没有 studio 用量记录 →
  //     用 /sessions/hermes/:id 的 in+out（loadMessages 已回填），否则恒为 0
  if (!used && state.curHermes) {
    used = (Number(state.hermesUsage.input) || 0) + (Number(state.hermesUsage.output) || 0);
  }
  if (!used) {
    // 退路：REST 的 input+output（与 web 版 fallback 一致，不加 cache_read）
    const usage = await api('/api/studio/sessions/' + encodeURIComponent(id) + '/usage'
      + '?profile=' + encodeURIComponent(state.profile), { noProfileHeader: true })
      .catch(() => null);
    if (state.cur !== id) return;
    if (usage) {
      used = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    }
  }
  renderContextBar(used, limit);
}

/** socket 事件里带 contextTokens 时统一走这里。 */
function setContextTokens(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) state.contextTokens = n;
}

/* ---- 发送 ---- */
function newSessionId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'mu';
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text && !pending.length) return;
  if (!state.socket || !state.socket.connected) {
    toast('连接已断开，正在重连…');
    connectSocket();
    return;
  }
  if (state.curHermes) {
    toast('企微会话 v1 只读，请在企业微信里回复');
    return;
  }
  if (!state.cur) state.cur = newSessionId();

  const sid = state.cur;
  const busy = !!pending.length;
  // 会话还在跑（本地流式 / 服务端忙）→ 这条会被服务端排队：只进排队区，
  // **不进已发送消息流**，否则同一句话会同时以「排队中」和「已发送」出现。
  const live = !!state.working[sid] || !!(state.streaming && state.streaming.sid === sid);
  const queueId = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // 先把消息画出来（含附件），不等上传返回
  const renderables = pending.map((a) => ({
    kind: a.kind,
    name: a.name,
    path: a.uploaded ? a.uploaded.path : '',
    media_type: a.type,
    localUrl: a.previewUrl,
  }));
  if (live) {
    state.queued.push({
      id: queueId, role: 'user', content: text, images: renderables,
      ts: Date.now() / 1000, queued: true,
    });
    renderMsgs();
    jumpToLatest();
  } else {
    addMsg({
      role: 'user',
      content: text,
      images: renderables,
    });
  }
  if (text) {
    input.value = '';
    autoGrow(input);
  }
  const myAttachments = pending.slice();
  pending = [];
  renderAttachments();

  if (!live) {
    markWorking(sid, true);
    startStream(sid);
    jumpToLatest();          // 自己发言后必定定位到底部
    startThinkingAt(0);          // 本地发起即起计时，run.started 到达后会校准
    if (busy) updateChatSub('附件上传中…');
  } else {
    updateChatSub('排队中…（' + state.queued.length + '）');
  }

  // 图片还没传完就等一下；失败则退化成纯文本并提示
  buildAndSend(sid, text, myAttachments, queueId);
  loadSessionsSoon();
  // 新会话的标题取第一条**真正发出**的消息；排队中的那条不能抢标题（用户 2026-10-05 截图发现）
  if (!live && !state.sessions.find((x) => x.id === sid)) {
    state.curTitle = (text || '（附件）').slice(0, 24);
    $('chat-title').textContent = state.curTitle + '…';
  }
}

/** 等附件上传完成，组装 ContentBlock[] 后 emit run。 */
async function buildAndSend(sid, text, attachments, queueId) {
  // 对这些附件补齐上传状态
  await uploadAttachmentsFor(attachments);
  const failed = attachments.filter((a) => a.err);
  const ready = attachments.filter((a) => a.uploaded && !a.err);

  if (failed.length) {
    toast(failed.length + ' 个附件上传失败：' + (failed[0].err || '').slice(0, 40));
  }

  const blocks = [];
  if (text.trim()) blocks.push({ type: 'text', text: text.trim() });
  // ContentBlock：图片 → image；其他 → file（与服务端/web 端一致）
  for (const a of ready) {
    blocks.push({
      type: a.kind === 'file' ? 'file' : 'image',
      name: a.uploaded.name,
      path: a.uploaded.path,
      media_type: a.type,
    });
  }

  const body = {
    session_id: sid,
    profile: state.profile,
    // 服务端用 queue_id 作为队列条目的 id（web 同款）：排队快照/@插入都靠它对账
    queue_id: queueId,
  };
  // 纯文本走 input 字符串，带附件走 ContentBlock 数组（与 web 版 buildContentBlocks 一致）
  if (blocks.length === 1 && blocks[0].type === 'text') {
    body.input = blocks[0].text;
  } else if (blocks.length) {
    body.input = blocks;
  } else {
    toast('没有可发送的内容');
    markWorking(sid, false);
    updateChatSub(subLine(state.curModel));
    return;
  }
  if (state.chosenModel) {
    body.model = state.chosenModel.model;
    body.provider = state.chosenModel.provider;
  }
  if (state.reasoningEffort) body.reasoning_effort = state.reasoningEffort;
  // 新会话：分类随首个 run 落库（服务端 createSession 读 category_id；老会话改了没用）
  if (!state.sessions.find((x) => x.id === sid) && state.newSessionCategoryId != null) {
    body.category_id = state.newSessionCategoryId;
  }
  startThinkingAt(0);
  try {
    state.socket.emit('run', body);
    loadSessionsSoon();
    setTimeout(loadContextUsage, 6000);   // 服务端统计有延迟
  } catch (e) {
    finishStream(null, '发送失败：' + e.message);
    markWorking(sid, false);
  }
}

/** 上传指定附件（复用 pending 渲染逻辑之外的纯函数版本）。 */
async function uploadAttachmentsFor(attachments) {
  const todo = attachments.filter((a) => !a.uploaded && !a.err);
  if (!todo.length) return;
  await Promise.all(todo.map(async (a) => {
    const fd = new FormData();
    fd.append('file', a.file, a.name);
    try {
      const headers = {};
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
      headers['X-Hermes-Profile'] = state.profile;
      const res = await fetch(state.base.replace(/\/$/, '') + '/api/studio/uploads', {
        method: 'POST', headers, body: fd,
      });
      if (res.status === 401) { logout(true); throw new Error('登录已过期'); }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        let msg = 'HTTP ' + res.status;
        try { msg = (JSON.parse(t) && (JSON.parse(t).error)) || msg; } catch (e) {}
        throw new Error(msg);
      }
      const data = await res.json();
      const files = data.files || [];
      if (!files.length) throw new Error('服务端未返回文件信息');
      a.uploaded = files[0];
    } catch (e) {
      a.err = e.message || '上传失败';
    }
  }));
}

function stopRun() {
  if (!state.socket || !state.cur) return;
  state.socket.emit('abort', { session_id: state.cur });
  updateChatSub('正在停止…');
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
}

/* ---- 审批 / 追问卡片 ---- */
function renderCards() {
  const el = $('chat-cards');
  let html = '';

  // 任务计划卡（plan.updated）：只在当前会话、且计划未结束时显示
  const plan = state.plan;
  if (plan && plan.session_id === state.cur && Array.isArray(plan.plan) && plan.plan.length) {
    const steps = plan.plan.map((s) => {
      const mark = s.status === 'completed' ? '✓' : (s.status === 'in_progress' ? '●' : '○');
      const cls = s.status === 'completed' ? 'done' : (s.status === 'in_progress' ? 'doing' : 'todo');
      return '<div class="plan-step ' + cls + '"><span class="ps-mark">' + mark + '</span>' +
        '<span class="ps-text">' + esc(s.step) + '</span></div>';
    }).join('');
    const done = plan.plan.filter((s) => s.status === 'completed').length;
    html += '<div class="card plan-card">' +
      '<div class="card-title">🗒 任务计划 ' + done + '/' + plan.plan.length + '</div>' +
      (plan.explanation ? '<div class="card-body">' + esc(plan.explanation) + '</div>' : '') +
      '<div class="plan-steps">' + steps + '</div>' +
    '</div>';
  }

  html += state.cards.map((c) => {
    if (c.kind === 'diff') {
      const ch = c.change || {};
      const files = Array.isArray(ch.files) ? ch.files : [];
      const shown = files.slice(0, 5).map((f) =>
        '<div class="diff-file"><span class="df-name">' + esc(f.path || f.name || '') + '</span>' +
        '<span class="df-stat">+' + Number(f.additions || 0) + ' −' + Number(f.deletions || 0) + '</span></div>').join('');
      return '<div class="card diff-card" data-id="' + esc(c.id) + '">' +
        '<div class="card-title">📝 本轮文件变更 · ' + Number(ch.files_changed || files.length) + ' 个文件</div>' +
        '<div class="card-body">+' + Number(ch.additions || 0) + ' / −' + Number(ch.deletions || 0) +
          (ch.truncated ? ' · 部分 diff 已截断' : '') + '</div>' +
        (shown ? '<div class="diff-files">' + shown + '</div>' : '') +
        '<div class="card-actions"><button data-act="dismiss-diff">知道了</button></div>' +
      '</div>';
    }
    if (c.kind === 'approval') {
      return '<div class="card" data-id="' + esc(c.id) + '">' +
        '<div class="card-title">🔐 ' + esc(c.title) + '</div>' +
        '<div class="card-body">' + esc(c.body || '') + '</div>' +
        '<div class="card-actions">' +
          '<button class="primary" data-act="once">允许一次</button>' +
          '<button data-act="session">本会话允许</button>' +
          '<button data-act="always">总是允许</button>' +
          '<button data-act="deny">拒绝</button>' +
        '</div></div>';
    }
    return '<div class="card" data-id="' + esc(c.id) + '">' +
      '<div class="card-title">❓ ' + esc(c.title) + '</div>' +
      '<div class="card-body">' + esc(c.body || '') + '</div>' +
      '<input placeholder="输入补充说明…" data-role="clarify-input">' +
      '<div class="card-actions"><button class="primary" data-act="clarify-send">提交</button></div>' +
    '</div>';
  }).join('');

  el.innerHTML = html;

  el.querySelectorAll('.card').forEach((card) => {
    const id = card.getAttribute('data-id');
    const c = state.cards.find((x) => x.id === id);
    if (!c) {
      // 计划卡没有 data-id，不需要绑定
      return;
    }
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
        if (act === 'dismiss-diff') {
          state.cards = state.cards.filter((x) => x.id !== id);
          renderCards();
          return;
        }
        if (!state.socket) return;
        if (act === 'clarify-send') {
          const v = card.querySelector('[data-role="clarify-input"]').value.trim();
          if (!v) { toast('请输入补充说明'); return; }
          state.socket.emit('clarify.respond', { session_id: c.sid, clarify_id: id, response: v });
          addMsg({ role: 'user', content: v });
        } else {
          state.socket.emit('approval.respond', { session_id: c.sid, approval_id: id, choice: act });
        }
        state.cards = state.cards.filter((x) => x.id !== id);
        renderCards();
      });
    });
  });
}

/* ============================== 模型选择 ============================== */
async function loadModels() {
  if (state.models.length) return;
  try {
    const res = await api('/api/hermes/available-models?profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
    const out = [];
    const push = (provider, id, name) => {
      if (!id) return;
      out.push({ provider: provider || '', model: id, name: name || id });
    };
    if (Array.isArray(res.groups)) {
      for (const g of res.groups) {
        const models = g.models || [];
        for (const m of models) {
          if (typeof m === 'string') push(g.provider, m);
          else push(g.provider, m.id || m.model || m.name, m.name || m.label);
        }
      }
    } else if (Array.isArray(res.models)) {
      for (const m of res.models) {
        if (typeof m === 'string') push('', m);
        else push(m.provider, m.id || m.model || m.name, m.name || m.label);
      }
    } else if (Array.isArray(res.available_models)) {
      for (const m of res.available_models) push('', typeof m === 'string' ? m : (m.id || m.name));
    }
    state.models = out;
  } catch (e) {
    state.models = [];
  }
}

function renderModelSheet() {
  const el = $('model-list');
  if (!state.models.length) {
    el.innerHTML = '<div class="empty" style="padding:18px">没有拿到模型列表，可使用默认模型</div>';
    return;
  }
  el.innerHTML = state.models.map((m, i) => {
    const active = state.chosenModel && state.chosenModel.model === m.model && state.chosenModel.provider === m.provider;
    return '<div class="model-item' + (active ? ' active' : '') + '" data-i="' + i + '">' +
      '<span>' + esc(m.name || m.model) + '</span>' +
      '<span class="m-prov">' + esc(m.provider || '') + '</span></div>';
  }).join('');
  el.querySelectorAll('.model-item').forEach((row) => {
    row.addEventListener('click', () => {
      const m = state.models[+row.getAttribute('data-i')];
      applyModelChoice(m.provider, m.model, m.name || m.model);
    });
  });
}

/**
 * 选模型。**关键：必须调 REST 持久化到会话**。
 * web 版走 `POST /api/studio/sessions/:id/model`；只在 run body 里带 model/provider
 * 是不生效的（服务端以 session 上存的模型为准）——这就是「改了模型不生效」的根因。
 */
async function applyModelChoice(provider, model, label) {
  state.chosenModel = { provider: provider || '', model: model };
  setPillText($('chat-model'), String(label || model).slice(0, 12));
  closeModelSheet();           // 选完就收起（与之前行为一致）
  loadContextUsage();          // 换模型 → 上限会变

  if (!state.cur || state.curHermes) {
    toast('已选模型：' + (label || model));
    return;
  }
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(state.cur) + '/model'
      + '?profile=' + encodeURIComponent(state.profile), {
      method: 'POST',
      body: { model: model, provider: provider || '' },
    });
    state.curModel = model;
    state.curProvider = provider || '';
    loadContextUsage();          // 用新模型重新查上限（会话已生效）
    toast('模型已切换：' + (label || model));
  } catch (e) {
    toast('模型切换失败：' + (e.message || ''));
  }
}

/** 思考级别（reasoning effort）。取值与文案复刻 web 端。 */
const EFFORT_CHOICES = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = {
  '': '默认 (config.yaml)', none: '无', minimal: '极低', low: '低',
  medium: '中', high: '高', xhigh: '超高', max: 'Max',
};
// 逐档配色（同 web 端 reasoningEffortAccentColors）
const EFFORT_ACCENTS = ['#94a3b8', '#2ac8e9', '#2bd9b4', '#4ed786', '#b9d93a', '#f9c33c', '#f77734', '#ef4444'];

function effortIndex(v) {
  const i = EFFORT_CHOICES.indexOf(String(v || ''));
  return i >= 0 ? i : 0;
}

/** 同步滑块/标签/配色到当前 reasoningEffort。 */
function renderEffortSlider() {
  const slider = $('effort-slider');
  const label = $('effort-label');
  if (!slider || !label) return;
  const idx = effortIndex(state.reasoningEffort);
  slider.value = String(idx);
  label.textContent = EFFORT_LABELS[EFFORT_CHOICES[idx]] || '默认';
  const accent = EFFORT_ACCENTS[idx] || EFFORT_ACCENTS[0];
  slider.style.setProperty('--effort-accent', accent);
  label.style.color = accent;
}

async function applyReasoningEffort(effort) {
  state.reasoningEffort = effort || '';
  renderEffortSlider();
  toast('推理强度：' + (EFFORT_LABELS[state.reasoningEffort] || '默认'));
  if (!state.cur || state.curHermes) return;
  try {
    await api('/api/studio/sessions/' + encodeURIComponent(state.cur) + '/reasoning-effort'
      + '?profile=' + encodeURIComponent(state.profile), {
      method: 'POST',
      body: { reasoningEffort: effort || '' },
    });
  } catch (e) {
    toast('推理强度设置失败：' + (e.message || ''));
  }
}

function closeModelSheet() {
  $('chat-model-sheet').classList.add('hidden');
}

/* ============================== 设置 ============================== */
/** 版本号：真源是 build.sh 读的 VERSION 文件，构建时内联进 inline.html。 */
const APP_VERSION = '__APP_VERSION__';

function renderSettings() {
  $('set-base').textContent = state.base;
  $('set-user').textContent = state.user;
  $('set-version').textContent = 'v' + APP_VERSION;
  const sv = $('set-studio-ver');
  if (sv) {
    const ver = state.studio.version;
    const bad = ver && !studioVersionOk(ver);
    sv.textContent = ver ? ('v' + ver) : '未知';
    sv.classList.toggle('bad', !!bad);
  }
  const mid = $('set-machine');
  if (mid) mid.textContent = state.studio.machineId || '—';
  const sel = $('set-profile');
  sel.innerHTML = (state.profiles.length ? state.profiles : [state.profile])
    .map((p) => '<option value="' + esc(p) + '"' + (p === state.profile ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
  document.querySelectorAll('#theme-seg .seg-item').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-theme') === state.theme);
  });
}

/* ============================== 事件绑定 ============================== */
function bind() {
  $('login-btn').addEventListener('click', doLogin);
  $('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  $('fab-new').addEventListener('click', () => {
    state.cur = newSessionId();
    state.curHermes = false;
    state.curTitle = '';
    state.msgs = [];
    state.cards = [];
    state.streaming = null;
    state.newSessionCategoryId = null;   // 新会话默认未分类，可在「分类」里先选好
    state.chosenModel = state.chosenModel || null;
    show('chat');
    $('chat-title').textContent = '新会话';
    updateChatSub('新会话 · ' + state.profile);
    $('chat-cat-sheet').classList.add('hidden');
    updateCatChip();
    renderMsgs();
    renderCards();
    $('chat-input').focus();
    loadModels();
    loadContextUsage();     // 新会话：显示上限（用量为 0）
  });

  $('btn-settings').addEventListener('click', () => switchTab('settings'));
  $('btn-search').addEventListener('click', () => toggleSearch(true));
  $('wb-refresh').addEventListener('click', () => { renderWorkbench(); });
  $('wb-back').addEventListener('click', wbClose);
  $('search-cancel').addEventListener('click', () => toggleSearch(false));
  $('search-input').addEventListener('input', () => {
    clearTimeout(bind._st);
    bind._st = setTimeout(doSearch, 400);
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
  });

  $('wecom-refresh').addEventListener('click', loadWecom);

  $('chat-back').addEventListener('click', closeChat);
  $('chat-send').addEventListener('click', sendMessage);
  // 滚动状态：用户手动上滑 → 停自动跟随；回到底 → 恢复跟随
  $('msg-list').addEventListener('scroll', () => {
    atBottom = isAtBottom();
    updateJumpButton();
  }, { passive: true });
  // 「⬇️ 回到底部」按钮
  $('btn-jump-bottom').addEventListener('click', () => {
    jumpToLatest();
  });
  // 点上下文区域：在「262144 ↔ 1048576」间切换上限覆盖
  $('ctx-bar').addEventListener('click', cycleContextLimit);
  // 粘贴图片发送（复刻 web 端）。按钮已弃用，避免输入区太挤。
  // 只在聊天视图上绑一次：paste 会从输入框冒泡上来，绑两处会重复处理。
  $('view-chat').addEventListener('paste', handlePaste);
  // 附件入口（Ekko 式）：不再依赖 WebView 粘贴（Android WebView 的 paste 常不带图片文件）
  $('chat-plus').addEventListener('click', openAttachPanel);
  $('attach-cancel').addEventListener('click', closeAttachPanel);
  $('attach-panel').addEventListener('click', (e) => {
    if (e.target === $('attach-panel')) closeAttachPanel();
  });
  document.querySelectorAll('.attach-item').forEach((b) => {
    b.addEventListener('click', () => triggerPicker(b.getAttribute('data-kind')));
  });
  ['pick-photo', 'pick-camera', 'pick-file'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', (e) => {
      onFilesPicked(e.target.files);
      e.target.value = '';
    });
  });
  document.querySelectorAll('#theme-seg .seg-item').forEach((b) => {
    b.addEventListener('click', () => setTheme(b.getAttribute('data-theme')));
  });
  $('btn-switch-studio').addEventListener('click', () => {
    logout(false);
    toast('已返回登录页，可切换或添加 Studio');
  });
  // 图片全屏查看：消息里的 .chat-img 点一下打开灯箱（遮罩/✕ 关闭）
  $('msg-list').addEventListener('click', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img.chat-img') : null;
    if (!img) return;
    e.preventDefault();
    openLightbox(img.getAttribute('src'));
  });
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox') || e.target.closest('#lightbox-close')) closeLightbox();
  });
  // 长按气泡复制文本（WebView 里 navigator.clipboard 常不可用 → 优先原生桥）
  bindLongPressCopy($('msg-list'));

  $('chat-stop').addEventListener('click', stopRun);
  $('chat-input').addEventListener('input', (e) => autoGrow(e.target));
  // 回车默认换行（md 写代码/列表刚需）。发送走按钮，不抢键盘。

  $('chat-model').addEventListener('click', async () => {
    const sheet = $('chat-model-sheet');
    if (sheet.classList.contains('hidden')) {
      await loadModels();
      renderModelSheet();
      renderEffortSlider();
      sheet.classList.remove('hidden');
    } else {
      closeModelSheet();
    }
  });
  // 关闭：✕ / 完成 / 点面板外
  $('model-sheet-close').addEventListener('click', closeModelSheet);
  $('model-sheet-done').addEventListener('click', closeModelSheet);
  // 推理强度滑块：拖动即改（input 事件实时反馈，change 时才发请求）
  $('effort-slider').addEventListener('input', (e) => {
    const idx = Number(e.target.value) || 0;
    const v = EFFORT_CHOICES[idx] || '';
    state.reasoningEffort = v;
    $('effort-label').textContent = EFFORT_LABELS[v] || '默认';
    const accent = EFFORT_ACCENTS[idx] || EFFORT_ACCENTS[0];
    e.target.style.setProperty('--effort-accent', accent);
    $('effort-label').style.color = accent;
  });
  $('effort-slider').addEventListener('change', (e) => {
    const idx = Number(e.target.value) || 0;
    applyReasoningEffort(EFFORT_CHOICES[idx] || '');
  });
  $('model-default').addEventListener('click', () => {
    state.chosenModel = null;
    setPillText($('chat-model'), '模型');
    closeModelSheet();
    toast('使用默认模型');
  });

  // ---- 会话分类 ----
  // 聊天页：新建会话先选归属，老会话改归属
  $('chat-cat').addEventListener('click', async () => {
    const sheet = $('chat-cat-sheet');
    if (sheet.classList.contains('hidden')) await openChatCatSheet();
    else sheet.classList.add('hidden');
  });
  $('cat-sheet-close').addEventListener('click', () => $('chat-cat-sheet').classList.add('hidden'));
  $('cat-new').addEventListener('click', async () => {
    const c = await createCategoryFlow();
    if (!c) return;
    await applyChatCategory('c' + c.id);   // 与 web 一致：新建后直接归到该分类
    renderCatSheet();
  });
  // 会话页：分类管理入口
  $('btn-cats').addEventListener('click', () => openCategoryManager());

  $('set-profile').addEventListener('change', (e) => {
    state.profile = e.target.value;
    localStorage.setItem('hm_profile', state.profile);
    toast('已切换 profile：' + state.profile);
    connectSocket();
  });

  $('btn-logout').addEventListener('click', () => logout(false));
  $('btn-finish').addEventListener('click', () => {
    if (window.Android && window.Android.finishApp) window.Android.finishApp();
  });

  // 会话列表定期刷新 + 联网恢复时刷新
  setInterval(() => {
    if (state.view === 'sessions') loadSessions();
    if (state.view === 'wecom') loadWecom();
  }, 30000);
  window.addEventListener('online', () => {
    if (state.token) { connectSocket(); loadSessions(); }
  });

  // 看门狗：界面说"在跑"但 45 秒没收到任何 socket 事件 → 强制重新同步。
  // 防的是"连接看着正常、事件其实丢了"这种情况（也是卡死的常见成因）。
  setInterval(() => {
    if (!state.cur || !state.working[state.cur]) return;
    if (!state.socket || !state.socket.connected) return;
    if (Date.now() - (state.lastEventAt || 0) < 45000) return;
    state.lastEventAt = Date.now();   // 先续期，避免连续触发
    resyncOpenSession();
  }, 20000);

  // 回到前台重新同步（复刻 web 的 visibilitychange 处理）。
  // Android WebView 后台会挂起 JS 定时器、socket 也常被系统断掉，
  // 回前台若不重新 resume，界面就一直停在离开时的旧状态。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.token) return;
    if (!state.socket || !state.socket.connected) {
      sawDisconnect = true;
      connectSocket();          // 重连后 connect 回调会触发 resyncOpenSession
      if (state.cur) return;    // 交由重连流程统一同步，避免重复拉
    }
    resyncOpenSession();
  });
}

/* ============================== 工作台 ============================== */
/**
 * 工作台：把自建 Studio 里「不依赖云」的管理能力搬到手机上。
 * 全部走 /api/hermes/* 与 /api/studio/*，不做任何 Ekko 云调用。
 * 设计原则：只读优先、危险操作要二次确认、端点不支持时明确说「当前 Studio 不支持」。
 */

const WB_ITEMS = [
  { key: 'workflows', icon: '🧩', name: '工作流', desc: '查看与运行 Studio 工作流' },
  { key: 'skills', icon: '🧠', name: '技能', desc: '启停与查看技能' },
  { key: 'mcp', icon: '🔌', name: 'MCP', desc: '服务器状态 / 测试 / 重载' },
  { key: 'memory', icon: '📚', name: '记忆', desc: '笔记 / 用户画像 / 灵魂' },
  { key: 'jobs', icon: '⏱', name: '定时任务', desc: '查看、暂停、立即运行' },
  { key: 'usage', icon: '📊', name: '用量', desc: 'Token 与费用统计' },
  { key: 'perf', icon: '📈', name: '监控', desc: 'CPU / 内存 / 活跃会话' },
  { key: 'logs', icon: '📜', name: '日志', desc: '查看 Studio 运行日志' },
];

function wbItem(key) {
  return WB_ITEMS.find((x) => x.key === key) || null;
}

function renderWorkbench() {
  const el = $('wb-body');
  if (!el) return;
  el.innerHTML = '<div class="wb-grid">' + WB_ITEMS.map((item) =>
    '<button class="wb-tile" data-key="' + esc(item.key) + '">' +
      '<span class="wb-tile-ico">' + item.icon + '</span>' +
      '<span class="wb-tile-name">' + esc(item.name) + '</span>' +
      '<span class="wb-tile-desc">' + esc(item.desc) + '</span>' +
    '</button>').join('') + '</div>' +
    '<div class="wb-foot">Profile：' + esc(state.profile) + ' · Studio ' +
      esc(state.studio.version ? ('v' + state.studio.version) : '版本未知') + '</div>';
  el.querySelectorAll('.wb-tile').forEach((b) => {
    b.addEventListener('click', () => wbOpen(b.getAttribute('data-key')));
  });
}

/** 工作台子页统一的操作按钮区。 */
function wbActions(html) {
  const el = $('wb-actions');
  if (!el) return;
  el.innerHTML = html || '';
}

async function wbOpen(key) {
  const item = wbItem(key);
  if (!item) return;
  state.wb = { key: key, data: null, loading: true };
  $('wb-sheet').classList.remove('hidden');
  $('wb-title').textContent = item.name;
  $('wb-sub').textContent = item.desc;
  wbActions('');
  $('wb-content').innerHTML = '<div class="empty">加载中…</div>';
  await wbLoad();
}

function wbClose() {
  state.wb = { key: '', data: null, loading: false };
  $('wb-sheet').classList.add('hidden');
}

async function wbLoad() {
  const key = state.wb.key;
  if (!key) return;
  try {
    if (key === 'workflows') return await wbLoadWorkflows();
    if (key === 'skills') return await wbLoadSkills();
    if (key === 'mcp') return await wbLoadMcp();
    if (key === 'memory') return await wbLoadMemory();
    if (key === 'jobs') return await wbLoadJobs();
    if (key === 'usage') return await wbLoadUsage(7);
    if (key === 'perf') return await wbLoadPerf();
    if (key === 'logs') return await wbLoadLogs();
  } catch (e) {
    wbError(e);
  }
}

function wbError(e) {
  const msg = String((e && e.message) || e || '未知错误');
  const unsupported = /HTTP 40[45]|HTTP 501|not found|不支持|unknown/i.test(msg);
  $('wb-content').innerHTML = '<div class="wb-error">' +
    esc(unsupported ? '当前 Studio 不支持该功能：' + msg : '加载失败：' + msg) +
    '</div>';
}

/* ---------- 工作流 ---------- */
async function wbLoadWorkflows() {
  const res = await api('/api/studio/workflows?profile=' + encodeURIComponent(state.profile),
    { noProfileHeader: true });
  const list = (res && res.workflows) || [];
  state.wb.data = list;
  wbActions('<button class="icon-btn" id="wb-wf-refresh" title="刷新">⟳</button>');
  const btn = $('wb-wf-refresh');
  if (btn) btn.addEventListener('click', wbLoad);
  if (!list.length) {
    $('wb-content').innerHTML = '<div class="empty">还没有工作流<br><span class="wb-hint">在 Studio Web 版创建工作流后，这里可以查看并一键运行。</span></div>';
    return;
  }
  $('wb-content').innerHTML = list.map((wf) => {
    const nodes = Array.isArray(wf.nodes) ? wf.nodes.length : 0;
    const edges = Array.isArray(wf.edges) ? wf.edges.length : 0;
    return '<div class="wb-card" data-id="' + esc(wf.id) + '">' +
      '<div class="wb-card-head">' +
        '<span class="wb-card-title">' + esc(wf.name || '（未命名工作流）') + '</span>' +
        '<span class="wb-chip">' + nodes + ' 节点 · ' + edges + ' 连线</span>' +
      '</div>' +
      '<div class="wb-card-meta">' + esc(wf.workspace || '默认工作区') +
        ' · 更新 ' + fmtTime(wf.updated_at) + '</div>' +
      '<div class="wb-card-actions">' +
        '<button class="btn-ghost tiny" data-act="run">运行</button>' +
        '<button class="btn-ghost tiny" data-act="runs">运行记录</button>' +
      '</div>' +
    '</div>';
  }).join('');
  $('wb-content').querySelectorAll('.wb-card').forEach((card) => {
    const id = card.getAttribute('data-id');
    const wf = list.find((x) => x.id === id) || {};
    card.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'run') wbRunWorkflow(id, wf.name || '');
        if (act === 'runs') wbShowWorkflowRuns(id, wf.name || '');
      });
    });
  });
}

async function wbRunWorkflow(id, name) {
  const ok = await confirmDialog('运行工作流「' + (name || id) + '」？', '将在 Studio 上立即执行一次（会自动选择起始节点）。');
  if (!ok) return;
  try {
    await api('/api/studio/workflows/' + encodeURIComponent(id) + '/run', { method: 'POST', body: {} });
    toast('已开始运行');
    wbShowWorkflowRuns(id, name);
  } catch (e) {
    toast('运行失败：' + ((e && e.message) || e));
  }
}

const WB_RUN_STATUS = {
  queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', canceled: '已取消',
};

async function wbShowWorkflowRuns(id, name) {
  $('wb-sub').textContent = (name || '工作流') + ' · 运行记录';
  wbActions('<button class="btn-ghost tiny" id="wb-wf-back">← 列表</button>');
  const back = $('wb-wf-back');
  if (back) back.addEventListener('click', () => { wbActions(''); wbLoadWorkflows(); });
  $('wb-content').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const res = await api('/api/studio/workflows/' + encodeURIComponent(id) + '/runs?limit=20');
    const runs = (res && res.runs) || [];
    if (!runs.length) {
      $('wb-content').innerHTML = '<div class="empty">还没有运行记录</div>';
      return;
    }
    $('wb-content').innerHTML = runs.map((r) => {
      const status = String(r.status || '');
      const label = WB_RUN_STATUS[status] || status;
      const cls = status === 'completed' ? 'ok' : (status === 'failed' ? 'bad' : (status === 'running' ? 'busy' : ''));
      const started = r.started_at || r.created_at;
      const dur = r.started_at && r.finished_at ? (r.finished_at - r.started_at) : 0;
      return '<div class="wb-row wb-run" data-run="' + esc(r.id) + '">' +
        '<div class="wb-row-main">' +
          '<div class="wb-row-title"><span class="wb-chip ' + cls + '">' + esc(label) + '</span> ' +
            esc(String(r.id).slice(0, 12)) + '</div>' +
          '<div class="wb-row-meta">' + fmtTime(started) +
            (dur ? ' · ' + formatElapsed(dur) : '') +
            (r.error ? ' · ' + esc(String(r.error).slice(0, 60)) : '') + '</div>' +
        '</div>' +
        ((status === 'running' || status === 'queued')
          ? '<button class="btn-ghost tiny" data-act="stop">停止</button>' : '') +
      '</div>';
    }).join('');
    $('wb-content').querySelectorAll('.wb-run').forEach((row) => {
      const runId = row.getAttribute('data-run');
      const stop = row.querySelector('[data-act="stop"]');
      if (stop) stop.addEventListener('click', () => wbStopRun(id, runId, name));
    });
  } catch (e) {
    wbError(e);
  }
}

async function wbStopRun(id, runId, name) {
  const ok = await confirmDialog('停止这次运行？', '已完成的节点会保留，未开始的节点不再执行。');
  if (!ok) return;
  try {
    await api('/api/studio/workflows/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(runId) + '/stop',
      { method: 'POST' });
    toast('已请求停止');
    wbShowWorkflowRuns(id, name);
  } catch (e) {
    toast('停止失败：' + ((e && e.message) || e));
  }
}

/* ---------- 技能 ---------- */
async function wbLoadSkills() {
  const res = await api('/api/hermes/skills');
  const cats = (res && res.categories) || [];
  state.wb.data = res || {};
  wbActions('<button class="icon-btn" id="wb-sk-refresh" title="刷新">⟳</button>');
  const btn = $('wb-sk-refresh');
  if (btn) btn.addEventListener('click', wbLoad);
  if (!cats.length) {
    $('wb-content').innerHTML = '<div class="empty">暂无技能</div>';
    return;
  }
  $('wb-content').innerHTML = cats.map((cat) => {
    const skills = cat.skills || [];
    return '<div class="wb-group">' +
      '<div class="wb-group-head">' + esc(cat.name || '未分类') +
        '<span class="wb-chip">' + skills.length + '</span></div>' +
      skills.map((s) => {
        const on = s.enabled !== false;
        return '<div class="wb-row wb-skill" data-cat="' + esc(cat.name || '') + '" data-name="' + esc(s.name) + '">' +
          '<div class="wb-row-main">' +
            '<div class="wb-row-title">' + esc(s.name) + (s.pinned ? ' 📌' : '') + '</div>' +
            '<div class="wb-row-meta">' + esc(String(s.description || '').slice(0, 90)) + '</div>' +
          '</div>' +
          '<button class="wb-switch' + (on ? ' on' : '') + '" data-name="' + esc(s.name) + '" ' +
            'data-on="' + (on ? '1' : '0') + '">' + (on ? '已启用' : '已停用') + '</button>' +
        '</div>';
      }).join('') +
    '</div>';
  }).join('');
  $('wb-content').querySelectorAll('.wb-switch').forEach((b) => {
    b.addEventListener('click', () => wbToggleSkill(b));
  });
  // 点技能行 → 查看/编辑内容（开关自己处理，不冒泡）
  $('wb-content').querySelectorAll('.wb-skill').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.wb-switch')) return;
      wbOpenSkill(row.getAttribute('data-cat'), row.getAttribute('data-name'));
    });
  });
}

/** 查看/编辑单个技能内容（GET/PUT /api/hermes/skills/:category/:name）。 */
async function wbOpenSkill(cat, name) {
  $('wb-sub').textContent = (cat ? cat + ' / ' : '') + name;
  wbActions('<button class="btn-ghost tiny" id="wb-skill-back">← 列表</button>');
  const back = $('wb-skill-back');
  if (back) back.addEventListener('click', () => { wbActions(''); wbLoadSkills(); });
  $('wb-content').innerHTML = '<div class="empty">读取中…</div>';
  const path = (cat ? encodeURIComponent(cat) + '/' : '') + encodeURIComponent(name);
  try {
    const res = await api('/api/hermes/skills/' + path);
    const content = (res && res.content) || '';
    $('wb-content').innerHTML =
      '<div class="wb-group"><div class="wb-group-head">SKILL 内容</div>' +
        '<textarea class="wb-textarea wb-skill-content" rows="20" spellcheck="false">' + esc(content) + '</textarea>' +
        '<div class="wb-card-actions"><button class="btn-primary tiny" id="wb-skill-save">保存</button></div>' +
      '</div>';
    const save = $('wb-skill-save');
    if (save) save.addEventListener('click', () => wbSaveSkill(path, name));
  } catch (e) {
    wbError(e);
  }
}

async function wbSaveSkill(path, name) {
  const ta = $('wb-content').querySelector('.wb-skill-content');
  const btn = $('wb-skill-save');
  if (!ta) return;
  if (btn) btn.disabled = true;
  try {
    await api('/api/hermes/skills/' + path, { method: 'PUT', body: { content: ta.value } });
    toast('已保存 ' + name);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function wbToggleSkill(btn) {
  const name = btn.getAttribute('data-name');
  const next = btn.getAttribute('data-on') !== '1';
  btn.disabled = true;
  try {
    await api('/api/hermes/skills/toggle', { method: 'PUT', body: { name: name, enabled: next } });
    btn.setAttribute('data-on', next ? '1' : '0');
    btn.classList.toggle('on', next);
    btn.textContent = next ? '已启用' : '已停用';
    toast((next ? '已启用 ' : '已停用 ') + name);
  } catch (e) {
    toast('操作失败：' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
  }
}

/* ---------- MCP ---------- */
async function wbLoadMcp() {
  const res = await api('/api/hermes/mcp/servers');
  const servers = (res && res.servers) || [];
  state.wb.data = res || {};
  wbActions('<button class="icon-btn" id="wb-mcp-reload" title="全部重载">⟳</button>');
  const btn = $('wb-mcp-reload');
  if (btn) btn.addEventListener('click', wbReloadMcp);
  const total = (res && res.total_tools) || 0;
  if (!servers.length) {
    $('wb-content').innerHTML = '<div class="empty">还没有配置 MCP 服务器<br><span class="wb-hint">在 Studio Web 版的 MCP 设置里添加。</span></div>';
    return;
  }
  $('wb-content').innerHTML =
    '<div class="wb-summary">共 ' + servers.length + ' 个服务器 · ' + total + ' 个工具</div>' +
    servers.map((s) => {
      const ok = !!s.connected;
      return '<div class="wb-card">' +
        '<div class="wb-card-head">' +
          '<span class="wb-card-title">' + esc(s.name) + '</span>' +
          '<span class="wb-chip ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '已连接' : '未连接') + '</span>' +
        '</div>' +
        '<div class="wb-card-meta">' + esc(s.transport || 'stdio') + ' · ' +
          Number(s.tools || 0) + ' 个工具' +
          (s.error ? ' · ' + esc(String(s.error).slice(0, 60)) : '') + '</div>' +
        '<div class="wb-card-actions">' +
          '<button class="btn-ghost tiny" data-act="test">测试</button>' +
          '<button class="btn-ghost tiny" data-act="reload">重载</button>' +
        '</div>' +
      '</div>';
    }).join('');
  $('wb-content').querySelectorAll('.wb-card').forEach((card) => {
    const name = card.querySelector('.wb-card-title').textContent;
    card.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.getAttribute('data-act') === 'test') wbTestMcp(name);
        else wbReloadMcp(name);
      });
    });
  });
}

async function wbTestMcp(name) {
  toast('正在测试 ' + name + '…');
  try {
    const res = await api('/api/hermes/mcp/servers/' + encodeURIComponent(name) + '/test', { method: 'POST' });
    if (res && res.ok) toast('连接正常，' + (Array.isArray(res.tools) ? res.tools.length : 0) + ' 个工具可用');
    else toast('测试失败：' + ((res && res.error) || '未知错误'));
  } catch (e) {
    toast('测试失败：' + ((e && e.message) || e));
  }
}

async function wbReloadMcp(name) {
  try {
    const q = name ? ('?name=' + encodeURIComponent(name)) : '';
    await api('/api/hermes/mcp/reload' + q, { method: 'POST' });
    toast(name ? ('已重载 ' + name) : '已请求全部重载');
    setTimeout(wbLoad, 800);
  } catch (e) {
    toast('重载失败：' + ((e && e.message) || e));
  }
}

/* ---------- 记忆 ---------- */
async function wbLoadMemory() {
  const res = await api('/api/hermes/memory');
  state.wb.data = res || {};
  wbActions('');
  const secs = [
    { key: 'memory', label: '我的笔记', hint: '长期记忆：Agent 会读这段。' },
    { key: 'user', label: '用户画像', hint: '关于你的稳定信息（偏好、习惯）。' },
    { key: 'soul', label: '灵魂', hint: 'SOUL 配置：Agent 的人设与原则。' },
  ];
  $('wb-content').innerHTML = secs.map((s) =>
    '<div class="wb-group">' +
      '<div class="wb-group-head">' + s.label + '</div>' +
      '<div class="wb-hint">' + esc(s.hint) + '</div>' +
      '<textarea class="wb-textarea" data-sec="' + s.key + '" rows="6">' +
        esc((res && res[s.key]) || '') + '</textarea>' +
      '<div class="wb-card-actions"><button class="btn-primary tiny" data-save="' + s.key + '">保存' +
        (res && res[s.key + '_mtime'] ? ' · ' + fmtTime(res[s.key + '_mtime']) : '') + '</button></div>' +
    '</div>').join('');
  $('wb-content').querySelectorAll('[data-save]').forEach((b) => {
    b.addEventListener('click', () => wbSaveMemory(b.getAttribute('data-save'), b));
  });
}

async function wbSaveMemory(section, btn) {
  const ta = $('wb-content').querySelector('.wb-textarea[data-sec="' + section + '"]');
  if (!ta) return;
  btn.disabled = true;
  try {
    await api('/api/hermes/memory', { method: 'POST', body: { section: section, content: ta.value } });
    toast('已保存 ' + section);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 定时任务 ---------- */
async function wbLoadJobs() {
  const res = await api('/api/hermes/jobs?include_disabled=true');
  const jobs = (res && res.jobs) || [];
  state.wb.data = jobs;
  wbActions('<button class="icon-btn" id="wb-job-refresh" title="刷新">⟳</button>');
  const btn = $('wb-job-refresh');
  if (btn) btn.addEventListener('click', wbLoad);
  if (!jobs.length) {
    $('wb-content').innerHTML = '<div class="empty">暂无定时任务<br><span class="wb-hint">在 Studio Web 版的定时任务里创建。</span></div>';
    return;
  }
  $('wb-content').innerHTML = jobs.map((j) => {
    const id = j.job_id || j.id;
    const enabled = !!j.enabled;
    const paused = String(j.state || '') === 'paused' || !!j.paused_at;
    const last = j.last_status ? String(j.last_status) : '';
    return '<div class="wb-card" data-id="' + esc(id) + '">' +
      '<div class="wb-card-head">' +
        '<span class="wb-card-title">' + esc(j.name || id) + '</span>' +
        '<span class="wb-chip ' + (enabled ? 'ok' : '') + '">' + (paused ? '已暂停' : (enabled ? '运行中' : '已停用')) + '</span>' +
      '</div>' +
      '<div class="wb-card-meta">' + esc(j.schedule_display || '—') +
        ' · 上次 ' + (j.last_run_at ? fmtTime(j.last_run_at) : '从未') +
        (last ? '（' + esc(last) + '）' : '') + '</div>' +
      '<div class="wb-card-meta">下次 ' + (j.next_run_at ? fmtTime(j.next_run_at) : '—') + '</div>' +
      '<div class="wb-card-actions">' +
        '<button class="btn-ghost tiny" data-act="run">立即运行</button>' +
        '<button class="btn-ghost tiny" data-act="history">运行历史</button>' +
        (paused
          ? '<button class="btn-ghost tiny" data-act="resume">恢复</button>'
          : '<button class="btn-ghost tiny" data-act="pause">暂停</button>') +
      '</div>' +
    '</div>';
  }).join('');
  $('wb-content').querySelectorAll('.wb-card').forEach((card) => {
    const id = card.getAttribute('data-id');
    card.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'history') wbShowJobHistory(id);
        else wbJobAction(id, act);
      });
    });
  });
}

/** 定时任务的运行历史（GET /api/cron-history?jobId=）。 */
async function wbShowJobHistory(jobId) {
  const job = (state.wb.data || []).find((j) => (j.job_id || j.id) === jobId) || {};
  $('wb-sub').textContent = (job.name || jobId) + ' · 运行历史';
  wbActions('<button class="btn-ghost tiny" id="wb-job-back">← 列表</button>');
  const back = $('wb-job-back');
  if (back) back.addEventListener('click', () => { wbActions(''); wbLoadJobs(); });
  $('wb-content').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const res = await api('/api/cron-history?jobId=' + encodeURIComponent(jobId));
    const runs = (res && res.runs) || [];
    if (!runs.length) {
      $('wb-content').innerHTML = '<div class="empty">该任务还没有运行记录</div>';
      return;
    }
    $('wb-content').innerHTML = runs.map((r) =>
      '<div class="wb-row wb-cron-run" data-file="' + esc(r.fileName) + '">' +
        '<div class="wb-row-main">' +
          '<div class="wb-row-title">' + esc(r.runTime || r.fileName) + '</div>' +
          '<div class="wb-row-meta">' + esc(r.fileName) +
            (r.size ? ' · ' + fileSizeText(r.size) : '') + '</div>' +
        '</div>' +
        '<span class="wb-chip">查看</span>' +
      '</div>').join('');
    $('wb-content').querySelectorAll('.wb-cron-run').forEach((row) => {
      row.addEventListener('click', () => wbShowCronRun(jobId, row.getAttribute('data-file')));
    });
  } catch (e) {
    wbError(e);
  }
}

/** 单次运行日志内容（GET /api/cron-history/:jobId/:fileName）。 */
async function wbShowCronRun(jobId, fileName) {
  $('wb-sub').textContent = fileName;
  wbActions('<button class="btn-ghost tiny" id="wb-cron-back">← 历史</button>');
  const back = $('wb-cron-back');
  if (back) back.addEventListener('click', () => { wbShowJobHistory(jobId); });
  $('wb-content').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const res = await api('/api/cron-history/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(fileName));
    const content = (res && res.content) || '';
    $('wb-content').innerHTML = '<pre class="wb-pre">' + esc(content) + '</pre>';
  } catch (e) {
    wbError(e);
  }
}

async function wbJobAction(id, act) {
  if (act === 'run') {
    const ok = await confirmDialog('立即运行这个任务？', '会在 Studio 上立刻执行一次（不影响原有排程）。');
    if (!ok) return;
  }
  try {
    await api('/api/hermes/jobs/' + encodeURIComponent(id) + '/' + act, { method: 'POST' });
    toast(act === 'run' ? '已触发运行' : (act === 'pause' ? '已暂停' : '已恢复'));
    setTimeout(wbLoad, 600);
  } catch (e) {
    toast('操作失败：' + ((e && e.message) || e));
  }
}

/* ---------- 用量 ---------- */
async function wbLoadUsage(days) {
  const d = [1, 7, 30].includes(days) ? days : 7;
  state.wb.data = { days: d };
  wbActions('');
  const params = new URLSearchParams({ days: String(d), profile: state.profile });
  const res = await api('/api/studio/usage/stats?' + params.toString(), { noProfileHeader: true });
  const inTok = Number(res.total_input_tokens || 0);
  const outTok = Number(res.total_output_tokens || 0);
  const cacheRead = Number(res.total_cache_read_tokens || 0);
  const cacheWrite = Number(res.total_cache_write_tokens || 0);
  const cost = Number(res.total_cost || 0);
  const sessions = Number(res.total_sessions || 0);
  const models = (res.model_usage || []).slice().sort((a, b) =>
    (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)).slice(0, 5);
  const daily = (res.daily_usage || []).slice(-14);
  const maxDaily = daily.reduce((m, x) => Math.max(m, Number(x.input_tokens || 0) + Number(x.output_tokens || 0)), 0) || 1;

  $('wb-content').innerHTML =
    '<div class="wb-seg">' +
      [1, 7, 30].map((n) =>
        '<button class="seg-item' + (n === d ? ' active' : '') + '" data-days="' + n + '">' +
        (n === 1 ? '今天' : n + ' 天') + '</button>').join('') +
    '</div>' +
    '<div class="wb-stats">' +
      '<div class="wb-stat"><b>' + fmtTokens(inTok + outTok) + '</b><span>输入+输出</span></div>' +
      '<div class="wb-stat"><b>' + fmtTokens(cacheRead) + '</b><span>缓存读取</span></div>' +
      '<div class="wb-stat"><b>' + (cost > 0 ? '$' + cost.toFixed(2) : '—') + '</b><span>费用</span></div>' +
      '<div class="wb-stat"><b>' + sessions + '</b><span>会话</span></div>' +
    '</div>' +
    '<div class="wb-summary">输入 ' + fmtTokens(inTok) + ' · 输出 ' + fmtTokens(outTok) +
      ' · 缓存写 ' + fmtTokens(cacheWrite) + '</div>' +
    (models.length
      ? '<div class="wb-group"><div class="wb-group-head">按模型</div>' + models.map((m) => {
          const tot = Number(m.input_tokens || 0) + Number(m.output_tokens || 0);
          const pct = (inTok + outTok) > 0 ? Math.round(tot / (inTok + outTok) * 100) : 0;
          return '<div class="wb-bar-row"><span class="wb-bar-name">' + esc(m.model) + '</span>' +
            '<span class="wb-bar"><i style="width:' + pct + '%"></i></span>' +
            '<span class="wb-bar-val">' + fmtTokens(tot) + '</span></div>';
        }).join('') + '</div>'
      : '') +
    (daily.length
      ? '<div class="wb-group"><div class="wb-group-head">每日趋势</div><div class="wb-days">' +
        daily.map((x) => {
          const tot = Number(x.input_tokens || 0) + Number(x.output_tokens || 0);
          const h = Math.max(2, Math.round(tot / maxDaily * 100));
          return '<div class="wb-day" title="' + esc(x.date + ' · ' + fmtTokens(tot)) + '">' +
            '<i style="height:' + h + '%"></i><span>' + esc(String(x.date).slice(5)) + '</span></div>';
        }).join('') + '</div></div>'
      : '');

  $('wb-content').querySelectorAll('.wb-seg .seg-item').forEach((b) => {
    b.addEventListener('click', () => wbLoadUsage(Number(b.getAttribute('data-days'))));
  });
}

/* ---------- 监控 ---------- */
async function wbLoadPerf() {
  const res = await api('/api/studio/performance/runtime');
  state.wb.data = res || {};
  wbActions('<button class="icon-btn" id="wb-perf-refresh" title="刷新">⟳</button>');
  const btn = $('wb-perf-refresh');
  if (btn) btn.addEventListener('click', wbLoad);
  const sys = (res && res.system) || {};
  const web = (res && res.web) || {};
  const bridge = (res && res.bridge) || {};
  const sess = (res && res.sessions) || {};
  const workers = Array.isArray(bridge.workers) ? bridge.workers : [];
  const mb = (n) => (Number(n || 0) / 1024 / 1024).toFixed(0) + ' MB';
  const webMem = Object.values(web.memory || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  $('wb-content').innerHTML =
    '<div class="wb-stats">' +
      '<div class="wb-stat"><b>' + (Number(sys.cpuPercent || 0)).toFixed(0) + '%</b><span>系统 CPU</span></div>' +
      '<div class="wb-stat"><b>' + (Number(sys.memoryPercent || 0)).toFixed(0) + '%</b><span>系统内存</span></div>' +
      '<div class="wb-stat"><b>' + Number(sess.active || 0) + '</b><span>活跃会话</span></div>' +
      '<div class="wb-stat"><b>' + Number(sess.running || 0) + '</b><span>正在运行</span></div>' +
    '</div>' +
    '<div class="wb-group"><div class="wb-group-head">进程</div>' +
      '<div class="wb-row"><div class="wb-row-main"><div class="wb-row-title">Web</div>' +
        '<div class="wb-row-meta">PID ' + esc(String(web.pid || '—')) + ' · 内存 ' +
        mb(webMem) + '</div></div></div>' +
      '<div class="wb-row"><div class="wb-row-main"><div class="wb-row-title">Bridge</div>' +
        '<div class="wb-row-meta">' + (bridge.reachable ? '可达' : '不可达') +
        ' · Broker ' + (bridge.broker && bridge.broker.running ? '运行中' : '已停止') +
        ' · ' + workers.length + ' 个 Worker</div></div></div>' +
    '</div>' +
    (workers.length
      ? '<div class="wb-group"><div class="wb-group-head">Workers</div>' + workers.map((w) =>
          '<div class="wb-row"><div class="wb-row-main">' +
            '<div class="wb-row-title">' + esc(w.profile || ('worker ' + w.pid)) + '</div>' +
            '<div class="wb-row-meta">PID ' + esc(String(w.pid || '—')) +
            ' · CPU ' + (Number(w.cpuPercent || 0)).toFixed(0) + '%' +
            ' · 内存 ' + mb(w.memoryRssBytes) +
            ' · 会话 ' + Number(w.sessionCount || 0) + '</div>' +
          '</div></div>').join('') + '</div>'
      : '') +
    '<div class="wb-foot">更新时间 ' + fmtTime((res && res.timestamp) || Date.now()) + '</div>';
}

/** 图片灯箱：全屏查看消息图片（Ekko 同款交互）。 */
function openLightbox(src) {
  if (!src) return;
  const box = $('lightbox');
  const img = $('lightbox-img');
  if (!box || !img) return;
  img.src = src;
  box.classList.remove('hidden');
}

function closeLightbox() {
  const box = $('lightbox');
  if (!box) return;
  box.classList.add('hidden');
  const img = $('lightbox-img');
  if (img) img.removeAttribute('src');
}

/** 复制文本：原生桥优先（WebView 的 navigator.clipboard 在 http/file 下常被禁）。 */
function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  try {
    if (window.Android && window.Android.copyText) {
      window.Android.copyText(s);
      return true;
    }
  } catch (e) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) {}
  return false;
}

/** 长按消息气泡 → 复制纯文本。 */
function bindLongPressCopy(root) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let current = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } current = null; };
  root.addEventListener('touchstart', (e) => {
    const p = (e.touches && e.touches[0]) || e;
    const bubble = e.target && e.target.closest ? e.target.closest('.bubble') : null;
    if (!bubble) return;
    current = bubble;
    startX = p.clientX; startY = p.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const b = current;
      current = null;
      if (!b) return;
      const text = (b.innerText || b.textContent || '').trim();
      if (!text) return;
      if (copyText(text)) toast('已复制');
      else toast('复制失败，请手动选择文字');
    }, 600);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    const p = (e.touches && e.touches[0]) || e;
    if (Math.abs(p.clientX - startX) > 12 || Math.abs(p.clientY - startY) > 12) clear();
  }, { passive: true });
  root.addEventListener('touchend', clear);
  root.addEventListener('touchcancel', clear);
}

/* ---------- 日志 ---------- */
async function wbLoadLogs() {
  const res = await api('/api/studio/logs');
  const files = (res && res.files) || [];
  state.wb.data = files;
  wbActions('<button class="icon-btn" id="wb-log-refresh" title="刷新"><svg class="ico"><use href="#i-refresh"/></svg></button>');
  const btn = $('wb-log-refresh');
  if (btn) btn.addEventListener('click', wbLoad);
  if (!files.length) {
    $('wb-content').innerHTML = '<div class="empty">还没有日志文件</div>';
    return;
  }
  $('wb-content').innerHTML = files.map((f) =>
    '<div class="wb-row wb-log-file" data-name="' + esc(f.name) + '">' +
      '<div class="wb-row-main">' +
        '<div class="wb-row-title">' + esc(f.name) + '</div>' +
        '<div class="wb-row-meta">' + esc(f.size || '') + ' · ' + esc(f.modified || '') + '</div>' +
      '</div>' +
      '<span class="wb-chip">查看</span>' +
    '</div>').join('');
  $('wb-content').querySelectorAll('.wb-log-file').forEach((row) => {
    row.addEventListener('click', () => wbShowLogFile(row.getAttribute('data-name')));
  });
}

const LOG_LEVELS = [['', '全部'], ['error', '错误'], ['warn', '警告'], ['info', '信息']];

async function wbShowLogFile(name, level) {
  const lv = level || '';
  $('wb-sub').textContent = name;
  wbActions('<button class="btn-ghost tiny" id="wb-log-back">← 文件</button>');
  const back = $('wb-log-back');
  if (back) back.addEventListener('click', () => { wbActions(''); wbLoadLogs(); });
  $('wb-content').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const qs = '?lines=200' + (lv ? '&level=' + encodeURIComponent(lv) : '');
    const res = await api('/api/studio/logs/' + encodeURIComponent(name) + qs);
    const entries = (res && res.entries) || [];
    const seg = '<div class="wb-seg">' + LOG_LEVELS.map(([v, label]) =>
      '<button class="seg-item' + (v === lv ? ' active' : '') + '" data-level="' + v + '">' + label + '</button>').join('') +
      '</div>';
    const body = entries.length
      ? '<div class="log-list">' + entries.map((e) => {
          const l = String(e.level || 'info').toLowerCase();
          const cls = l.includes('error') || l.includes('fatal') ? 'lv-error'
            : (l.includes('warn') ? 'lv-warn' : '');
          return '<div class="log-line ' + cls + '">' +
            '<div class="log-head"><span class="log-ts">' + esc(String(e.timestamp || '').slice(11, 19)) + '</span>' +
            '<span class="log-lv">' + esc(l) + '</span>' +
            '<span class="log-logger">' + esc(String(e.logger || '').slice(0, 24)) + '</span></div>' +
            '<div class="log-msg">' + esc(String(e.message || e.raw || '')) + '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="empty">没有符合条件的日志</div>';
    $('wb-content').innerHTML = seg + body;
    $('wb-content').querySelectorAll('.wb-seg .seg-item').forEach((b) => {
      b.addEventListener('click', () => wbShowLogFile(name, b.getAttribute('data-level')));
    });
  } catch (e) {
    wbError(e);
  }
}

/* ============================== 启动 ============================== */
function boot() {
  applyTheme();
  bind();
  fillLogin();
  renderStudioList();
  if (state.token) {
    // 校验 token 是否仍有效
    api('/api/auth/me', { noProfileHeader: true })
      .then(() => {
        connectSocket();
        loadAvatar();
        probeStudio();
        switchTab('sessions');
      })
      .catch(() => {
        show('login');
      });
  } else {
    show('login');
  }
}

boot();
