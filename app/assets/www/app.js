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
  /** 正在插入中的排队消息 id（服务端 run.queue_insertion.updated 推来） */
  queueInsertingId: null,
  /** 展开的工具轮次：runMarker -> true */
  expandedRuns: {},
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
  for (const v of ['login', 'sessions', 'wecom', 'settings', 'chat']) {
    $('view-' + v).classList.toggle('hidden', v !== view);
  }
  if (view === 'settings') renderSettings();
}

function switchTab(tab) {
  if (tab === 'sessions') { show('sessions'); loadSessions(); }
  else if (tab === 'wecom') { show('wecom'); loadWecom(); }
  else if (tab === 'settings') show('settings');
}

window.__onBack = function () {
  if (state.view === 'chat') { closeChat(); return true; }
  if (state.view === 'wecom' || state.view === 'settings') { switchTab('sessions'); return true; }
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
    paintStream();
  });

  // ---- 思考 ----
  const reasoning = (ev) => {
    if (!isMine(ev)) return;
    if (state.cur !== ev.session_id) return;
    if (!state.streaming || state.streaming.sid !== ev.session_id) startStream(ev.session_id);
    state.streaming.reasoning += (ev.text || ev.delta || '');
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

/** 会话行菜单（⋯ / 长按）：移动分类、打开。 */
async function openSessionMenu(sid) {
  const s = (state.sessions || []).find((x) => x.id === sid);
  if (!s) return;
  const key = await actionSheet(s.title || '（未命名会话）', [
    { key: 'cat', label: '移动到分类', note: (s.category_id != null && categoryName(s.category_id)) || '未分类' },
    { key: 'open', label: '打开会话' },
  ]);
  if (key === 'open') { openSession(sid, s.title || '', false, s.model || ''); return; }
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
  btn.textContent = '🏷 ' + (categoryName(chatCategoryId()) || '未分类');
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
  // 「最近」分组里补一个所属分类标签（web 的 resolveRecentSessionCategoryLabel）
  const catName = showCategory
    ? ((s.category_id != null && categoryName(s.category_id)) || '未分类')
    : '';
  const canManage = target !== 'wecom-list';   // 企微会话只读，不给分类入口
  return '<div class="row" data-id="' + esc(s.id) + '" data-hermes="' + (target === 'wecom-list' ? '1' : '') + '">' +
    '<div class="row-main">' +
      '<div class="row-title">' + esc(s.title || '（未命名会话）') + '</div>' +
      '<div class="row-preview">' + esc(s.preview || '') + '</div>' +
      '<div class="row-meta">' +
        (working ? '<span class="chip working">● 运行中</span>' : '') +
        (catName ? '<span class="chip cat">' + esc(catName) + '</span>' : '') +
        (s.model ? '<span class="chip">' + esc(s.model) + '</span>' : '') +
        (s.message_count != null ? '<span class="chip">' + s.message_count + ' 条</span>' : '') +
        (s.source ? '<span class="chip">' + esc(s.source) + '</span>' : '') +
      '</div>' +
    '</div>' +
    (canManage ? '<button class="row-more" title="更多">⋯</button>' : '') +
    '<div class="row-time">' + fmtTime(s.last_active || s.ended_at || s.started_at) + '</div>' +
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

function markWorking(sid, on) {
  if (!sid) return;
  if (on) state.working[sid] = true; else delete state.working[sid];
  if (on && state.cur === sid) {
    $('chat-stop').classList.remove('hidden');
  } else if (!on && state.cur === sid) {
    $('chat-stop').classList.add('hidden');
  }
  if (state.view === 'sessions') renderSessions();
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
async function loadWecom() {
  try {
    const res = await api('/api/studio/sessions/hermes?source=wecom_callback&limit=30&profile=' + encodeURIComponent(state.profile), { noProfileHeader: true });
    state.wecom = res.sessions || [];
    // 企微会话本身就是单一来源，不需要分组
    renderSessions(state.wecom, 'wecom-list', '暂无企微 Bot 会话', { flat: true });
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

/** 消息里的图片 HTML。优先用已上传 path（服务端），未上传完先用本地 blob 预览。 */
function imagesHtml(images) {
  if (!images || !images.length) return '';
  return images.map((img) => {
    const src = img.path ? imageSrcFor(img.path) : (img.localUrl || '');
    if (!src) return '';
    return '<div class="imgwrap"><img class="chat-img" alt="' + esc(img.name || '') + '" src="' + esc(src) + '"></div>';
  }).join('');
}

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
  let extra = '';
  if (m.reasoning) {
    extra = '<details class="reasoning"><summary>思考过程</summary><div class="reasoning-body">' + esc(m.reasoning) + '</div></details>';
  }
  const imgs = imagesHtml(m.images);
  // system 消息不带头像（居中提示条）
  const lineInner = side === 'system'
    ? wrapOverflow(md(m.content))
    : (side === 'user' ? userAvatarHtml() : botAvatarHtml()) +
      '<div class="bubble">' + (imgs + (m.content ? wrapOverflow(md(m.content)) : '')) + '</div>';
  return extra + '<div class="msg ' + side + '">' +
    '<div class="msg-line">' + lineInner + '</div>' +
    (m.ts ? '<div class="msg-time">' + fmtTime(m.ts) + '</div>' : '') +
  '</div>';
}

function streamHtml() {
  const st = state.streaming;
  let extra = '';
  if (st.reasoning) {
    extra = '<details class="reasoning"><summary>思考过程（进行中）</summary><div class="reasoning-body">' + esc(st.reasoning) + '</div></details>';
  }
  return extra + '<div class="msg assistant">' +
    '<div class="msg-line">' + botAvatarHtml() +
      '<div class="bubble caret" id="stream-bubble">' + (st.text ? wrapOverflow(md(st.text)) : '') + '</div>' +
    '</div>' +
  '</div>';
}

function startStream(sid) {
  if (state.streaming && state.streaming.sid === sid) return;
  // 保存上一条未结束的流
  if (state.streaming && state.streaming.text) {
    state.msgs.push({ key: 's' + Date.now(), role: 'assistant', content: state.streaming.text, reasoning: state.streaming.reasoning, ts: Date.now() / 1000 });
  }
  state.streaming = { sid, text: '', reasoning: '' };
  renderMsgs();
}

function paintStream() {
  const b = $('stream-bubble');
  if (!b) { renderMsgs(); return; }
  b.innerHTML = wrapOverflow(md(state.streaming.text));
  // 用户上滑翻历史时绝不打断；atBottom=true 时才跟随（沿用上次修复的语义）
  scrollBottom();
}

function finishStream(finalText, error) {
  const st = state.streaming;
  const text = finalText != null && finalText.length ? finalText : (st ? st.text : '');
  if (st && (text || st.reasoning)) {
    state.msgs.push({
      key: 'f' + Date.now(), role: 'assistant',
      content: text + (error ? '\n\n> ⚠ ' + error : ''),
      reasoning: st.reasoning, ts: Date.now() / 1000,
    });
  } else if (error) {
    state.msgs.push({ key: 'e' + Date.now(), role: 'system', content: '⚠ ' + error, ts: Date.now() / 1000 });
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

/* ============================== 图片附件 ============================== */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 单张上限 20MB（服务端硬限 50MB）

/** 当前待发送的附件：[{id, name, type, file, previewUrl, uploaded:{name,path}|null, err}] */
let pending = [];

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
    const status = a.err ? '<div class="up">失败</div>'
      : (a.uploaded ? '' : '<div class="up">上传中…</div>');
    return '<div class="att">' +
      '<img alt="" src="' + esc(a.previewUrl) + '">' + status +
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
  const el = $('img-picker');
  if (el) { el.value = ''; el.click(); }
}

function onFilesPicked(fileList) {
  const files = Array.prototype.slice.call(fileList || []);
  let skipped = 0;
  for (const f of files) {
    if (!/^image\//.test(f.type)) { skipped++; continue; }
    if (f.size > MAX_IMAGE_BYTES) { skipped++; continue; }
    pending.push({
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      name: f.name || ('image-' + Date.now() + '.png'),
      type: f.type || 'image/png',
      file: f,
      previewUrl: URL.createObjectURL(f),
      uploaded: null,
      err: null,
    });
  }
  if (skipped) toast('已跳过 ' + skipped + ' 个文件（仅支持 ≤20MB 的图片）');
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

  // 先把消息画出来（含图片），不等上传返回
  const renderables = pending.map((a) => ({
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
    if (busy) updateChatSub('图片上传中…');
  } else {
    updateChatSub('排队中…（' + state.queued.length + '）');
  }

  // 图片还没传完就等一下；失败则退化成纯文本并提示
  buildAndSend(sid, text, myAttachments, queueId);
  loadSessionsSoon();
  // 新会话的标题取第一条**真正发出**的消息；排队中的那条不能抢标题（用户 2026-10-05 截图发现）
  if (!live && !state.sessions.find((x) => x.id === sid)) {
    state.curTitle = (text || '（图片）').slice(0, 24);
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
    toast(failed.length + ' 张图片上传失败：' + (failed[0].err || '').slice(0, 40));
  }

  const blocks = [];
  if (text.trim()) blocks.push({ type: 'text', text: text.trim() });
  for (const a of ready) {
    blocks.push({
      type: 'image',
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
  el.innerHTML = state.cards.map((c) => {
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

  el.querySelectorAll('.card').forEach((card) => {
    const id = card.getAttribute('data-id');
    const c = state.cards.find((x) => x.id === id);
    if (!c) return;
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
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
  $('chat-model').textContent = String(label || model).slice(0, 10);
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
  const sel = $('set-profile');
  sel.innerHTML = (state.profiles.length ? state.profiles : [state.profile])
    .map((p) => '<option value="' + esc(p) + '"' + (p === state.profile ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
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
  // 保留隐藏的 file input 作为兜底（原生选择器仍可用）
  $('img-picker').addEventListener('change', (e) => {
    onFilesPicked(e.target.files);
    e.target.value = '';
  });
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
    $('chat-model').textContent = '模型';
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

/* ============================== 启动 ============================== */
function boot() {
  bind();
  fillLogin();
  if (state.token) {
    // 校验 token 是否仍有效
    api('/api/auth/me', { noProfileHeader: true })
      .then(() => {
        connectSocket();
        loadAvatar();
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
