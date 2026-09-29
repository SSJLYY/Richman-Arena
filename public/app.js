/* ============================================================
   Monopoly Online - Frontend Core (v2.1)
   Fixed: pos.r/c grid mapping, bankrupt flag, color sync,
   mortgage/unmortgage events, reconnect token, bot UI
   ============================================================ */
const socket = io();

// --- State & Config (synced with server) ---
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];
const PLAYER_AVATARS = ['🧑','👩','👨','👴','👵','🧒','👦','👧','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞'];

// rents: [空地, 1房, 2房, 3房, 4房, 🏨酒店]（与服务器 GROUP_INFO 同步；空地集齐全组×2）
const GROUP_META = {
  brown:    { name: '棕色', color: '#8B4513', houseCost: 500,  rents: [100,500,1500,4500,6250,7500] },
  lightblue:{ name: '浅蓝', color: '#5DADE2', houseCost: 500,  rents: [200,600,1800,5000,7000,9000] },
  pink:     { name: '粉色', color: '#EC407A', houseCost: 1000, rents: [300,900,2700,6000,9000,11000] },
  orange:   { name: '橙色', color: '#E67E22', houseCost: 1000, rents: [400,1000,3000,7000,9500,12000] },
  red:      { name: '红色', color: '#E74C3C', houseCost: 1500, rents: [500,1500,4500,8000,11000,13500] },
  yellow:   { name: '黄色', color: '#F1C40F', houseCost: 1500, rents: [600,1800,5000,9000,12000,14500] },
  green:    { name: '绿色', color: '#27AE60', houseCost: 2000, rents: [700,2000,5500,9500,13000,16000] },
  darkblue: { name: '深蓝', color: '#2C3E50', houseCost: 2000, rents: [800,2000,6000,10000,15000,18000] },
  railroad: { name: '铁路', color: '#7F8C8D', houseCost: 0, rents: [250,500,1000,2000] },
  utility:  { name: '公用', color: '#8E44AD', houseCost: 0, rents: [] },
};

function rentMul() {
  return (state.game && state.game.rentMul) || 1;
}

const state = {
  game: null,
  myId: null,
  myToken: null,
  zoom: 1,
  logFilter: 'all',
  selectedProp: null,
  tradeTarget: null,
  diceTimer: null,
  victoryShown: false,
  view: 'lobby',
  selectedAvatar: null,
  auctionHiddenNo: 0,  // 用户手动收起的拍卖编号
  lastCardTs: 0,       // 已展示过的卡
  flashCells: [],
  goldCells: [],       // 租金到账金色闪光格
  lastTickSecond: null,
  replayIdx: null,      // 回放模式：当前查看的快照下标（null = 直播） // 拍卖倒计时已滴答的秒数      // 本次刷新需要闪烁的格子
  proposalShownSeq: 0, // 已展示过的购地提案
  proposalModalOpen: false,
  tradeShownSeq: 0,    // 已展示过的交易提议
  tradeModalOpen: false,
};
let lastRooms = [];

// ── 棋盘增量渲染缓存 ──
// boardCells: cellId -> { el, cellName, price, house, dot, rent, sig }
//   首次渲染为 40 格建骨架并常驻；后续仅按 cell.id 增量 patch 动态状态，
//   未变化的格子复用同一 DOM 节点（render-test 断言依据）。
// boardCenterEl / boardCenterHtml：中央信息面板仅在内容变化时才重建。
const boardCells = {};
let boardCenterEl = null;
let boardCenterHtml = null;
// playerCards: playerId -> { div, dot, info, money, sig }（玩家面板增量复用）
const playerCards = {};
let playerOrderSig = null;
// lastLogSig：日志渲染签名，内容未变化时跳过重建
let lastLogSig = null;
const ICONS_META = { go:'🏁', jail:'🔒', parking:'🅿️', gotojail:'🚔', chance:'❓', chest:'📦', tax:'🏛️', railroad:'🚂', utility:'💡', casino:'🎰' };
function cellVisible(el, on) { if (el) el.style.display = on ? '' : 'none'; }
function cellStaticSig(cell) {
  // 静态结构签名：名称/类型/价格/网格位置任一变化 → 该格需整体重建
  return `${cell.name}|${cell.type}|${cell.group || ''}|${cell.price || 0}|${cell.pos.c}|${cell.pos.r}`;
}
function cellTitle(cell) {
  const ownerName = cell.owner ? (state.game.players[cell.owner]?.name || '') : '';
  return `${cell.name}${cell.price ? ' · ¥' + cell.price : ''}` +
    `${ownerName ? ' · ' + ownerName : ''}` +
    `${cell.mortgaged ? ' · 已抵押' : ''}` +
    `${cell.rent > 0 ? ' · 租金 ¥' + cell.rent : ''}`;
}

// --- Sound Engine (WebAudio 合成，无外部资源) ---
const Sound = {
  ctx: null,
  enabled: localStorage.getItem('monopoly_sound') !== 'off',
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  volume: Number(localStorage.getItem('monopoly_volume') || 70),
  play(notes, vol = 0.1) {
    vol = vol * (this.volume / 100);
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime;
      notes.forEach(([freq, dur, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, t0 + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + delay);
        osc.stop(t0 + delay + dur + 0.02);
      });
    } catch (e) { /* ignore */ }
  },
  dice()  { this.play([[220,0.08,0],[330,0.08,0.09],[262,0.08,0.18],[392,0.1,0.27]]); },
  gain()  { this.play([[523,0.1,0],[659,0.12,0.09],[784,0.16,0.18]]); },
  pay()   { this.play([[440,0.1,0],[330,0.1,0.1],[220,0.16,0.2]]); },
  build() { this.play([[392,0.06,0],[392,0.06,0.08],[523,0.12,0.16]]); },
  turn()  { this.play([[660,0.09,0],[880,0.09,0.1]]); },
  card()   { this.play([[660,0.09,0],[988,0.12,0.09]]); },
  gavel()  { this.play([[180,0.07,0],[140,0.1,0.08]]); },
  alarm()  { this.play([[523,0.1,0],[523,0.1,0.14],[523,0.1,0.28]]); },
  jackpot(){ this.play([[523,0.09,0],[659,0.09,0.08],[784,0.09,0.16],[1047,0.2,0.24]]); },
  win()   { this.play([[523,0.14,0],[659,0.14,0.13],[784,0.14,0.26],[1047,0.3,0.39]]); },
  lose()  { this.play([[330,0.16,0],[262,0.16,0.16],[196,0.28,0.32]]); },
};

// --- DOM Elements ---
const $ = id => document.getElementById(id);
const els = {
  loading: $('loading'),
  mainApp: $('mainApp'),
  lobby: $('lobby'),
  board: $('board'),
  boardWrapper: $('boardWrapper'),
  backBtn: $('backBtn'),
  roomLabel: $('roomLabel'),
  lobbyName: $('lobbyName'),
  avatarGrid: $('avatarGrid'),
  lobbyCreateBtn: $('lobbyCreateBtn'),
  joinRoomInput: $('joinRoomInput'),
  joinRoomBtn: $('joinRoomBtn'),
  lobbyRoomList: $('lobbyRoomList'),
  lobbyEmpty: $('lobbyEmpty'),
  refreshRoomsBtn: $('refreshRoomsBtn'),
  playersList: $('playersList'),
  startBtn: $('startBtn'),
  rollBtn: $('rollBtn'),
  buyBtn: $('buyBtn'),
  buildBtn: $('buildBtn'),
  mortgageBtn: $('mortgageBtn'),
  endTurnBtn: $('endTurnBtn'),
  tradeBtn: $('tradeBtn'),
  botBtn: $('botBtn'),
  actionHint: $('actionHint'),
  quickStats: $('quickStats'),
  log: $('log'),
  chatInput: $('chatInput'),
  sendChatBtn: $('sendChatBtn'),
  logFilter: $('logFilter'),
  diceOverlay: $('diceOverlay'),
  die1: $('die1'),
  die2: $('die2'),
  diceResult: $('diceResult'),
  turnBanner: $('turnBanner'),
  turnAvatar: $('turnAvatar'),
  turnText: $('turnText'),
  myInfo: $('myInfo'),
  myAvatar: $('myAvatar'),
  myName: $('myName'),
  myMoney: $('myMoney'),
  modalRoot: $('modalRoot'),
  toastContainer: $('toastContainer'),
  zoomIn: $('zoomIn'),
  zoomOut: $('zoomOut'),
  zoomReset: $('zoomReset'),
  settingsBtn: $('settingsBtn'),
  helpBtn: $('helpBtn'),
  bailBtn: $('bailBtn'),
  turnTimer: $('turnTimer'),
  delegateBtn: $('delegateBtn'),
  exitBtn: $('exitBtn'),
  auctionPanel: $('auctionPanel'),
  apName: $('apName'),
  apTopBid: $('apTopBid'),
  apTopBidder: $('apTopBidder'),
  apTimer: $('apTimer'),
  apHideBtn: $('apHideBtn'),
  apBid100: $('apBid100'),
  apBid500: $('apBid500'),
  apBid1000: $('apBid1000'),
  lobbyStats: $('lobbyStats'),
  tokenLayer: $('tokenLayer'),
  cardOverlay: $('cardOverlay'),
  dcIcon: $('dcIcon'),
  dcType: $('dcType'),
  dcText: $('dcText'),
  maxRoundsSel: $('maxRoundsSel'),
  roundLimitRow: $('roundLimitRow'),
  apHistory: $('apHistory'),
  inviteBtn: $('inviteBtn'),
  chartBtn: $('chartBtn'),
  overviewBtn: $('overviewBtn'),
  replayBtn: $('replayBtn'),
  roomSettingsRow: $('roomSettingsRow'),
  mapSel: $('mapSel'),
  turnTimeSel: $('turnTimeSel'),
  teamModeChk: $('teamModeChk'),
  botSpeedSel: $('botSpeedSel'),
  myStatsLine: $('myStatsLine'),
  moneyFloatLayer: $('moneyFloatLayer'),
  lobbySoloBtn: $('lobbySoloBtn'),
  apRent: $('apRent'),
  startMoneySel: $('startMoneySel'),
  jackpotChk: $('jackpotChk'),
  auctionChk: $('auctionChk'),
  roomSetupCard: $('roomSetupCard'),
  themeBtn: $('themeBtn'),
  themeBtnLobby: $('themeBtnLobby'),
  helpBtnLobby: $('helpBtnLobby'),
};

// ────────────────────────────────────────────────────────────
// UTILITY
// ────────────────────────────────────────────────────────────
function formatMoney(m) {
  return '¥' + Math.abs(m).toLocaleString();
}

function playerColor(pid) {
  if (!state.game) return '#999';
  const idx = state.game.order.indexOf(pid);
  return PLAYER_COLORS[idx >= 0 ? idx % PLAYER_COLORS.length : 0];
}

// 按背景色亮度选文字色：色块底色（地产组色/玩家色）跨主题固定，不能依赖 --text-inverse
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = [16, 8, 0].map(s => {
    const v = ((n >> s) & 255) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }).reduce((a, c, i) => a + [0.2126, 0.7152, 0.0722][i] * c, 0);
  return lum > 0.4 ? '#10131f' : '#ffffff';
}

// 版本角标：数据来自服务端 /version（package.json 不在静态目录内）
function syncVersion() {
  fetch('/version').then(r => r.json()).then(p => {
    document.querySelectorAll('.version').forEach(el => { el.textContent = 'v' + p.version; });
  }).catch(() => {});
}

// ────────────────────────────────────────────────────────────
// APPEARANCE: 深色玻璃 / 浅色玻璃 + 毛玻璃强度
// ?theme=light|dark &glass=full|soft|off 便于截图/联调覆盖本地偏好
// ────────────────────────────────────────────────────────────
const Theme = {
  _url(key) { return new RegExp('[?&]' + key + '=([a-z]+)').exec(location.search)?.[1]; },
  get() {
    const q = this._url('theme');
    if (q === 'light' || q === 'dark') return q;
    return localStorage.getItem('monopoly_theme') === 'light' ? 'light' : 'dark';
  },
  glass() {
    const q = this._url('glass');
    if (q === 'off' || q === 'soft') return q;
    const g = localStorage.getItem('monopoly_glass');
    return g === 'off' || g === 'soft' ? g : 'full';
  },
  apply() {
    const d = document.documentElement;
    const t = this.get();
    d.setAttribute('data-theme', t);
    d.setAttribute('data-glass', this.glass());
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#e8eefb' : '#070b1c');
    const icon = t === 'light' ? '☀️' : '🌙';
    if (els.themeBtn) {
      els.themeBtn.textContent = icon;
      els.themeBtn.setAttribute('aria-label', t === 'light' ? '切换为深色主题' : '切换为浅色主题');
    }
    if (els.themeBtnLobby) {
      els.themeBtnLobby.textContent = icon;
      els.themeBtnLobby.setAttribute('aria-label', t === 'light' ? '切换为深色主题' : '切换为浅色主题');
    }
  },
  toggle() {
    localStorage.setItem('monopoly_theme', this.get() === 'light' ? 'dark' : 'light');
    this.apply();
  },
  set(t) {
    localStorage.setItem('monopoly_theme', t === 'light' ? 'light' : 'dark');
    this.apply();
  },
  setGlass(level) {
    localStorage.setItem('monopoly_glass', level);
    this.apply();
  },
};
Theme.apply();

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  els.toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

// ────────────────────────────────────────────────────────────
// A11Y: 焦点陷阱 + 弹窗栈
// 所有弹窗都经 showModal / hideModal 进出，因此只需在这一对出入口
// 上做焦点管理：打开时把焦点移入并把 Tab 圈在内部，关闭时还原焦点。
// modalStack 栈式管理：showModal 语义是「替换」，新弹窗继承栈底的
// 触发元素（真正打开弹窗的那个按钮），关到空栈时才把焦点还给它。
// ────────────────────────────────────────────────────────────
const FOCUSABLE_SEL = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary',
  '[contenteditable="true"]', 'audio[controls]', 'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const modalStack = []; // { dialog, trigger, dismissible }
const MODAL_TITLE_ID = 'modalTitleText';

function dialogFocusables(dialog) {
  return Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.getAttribute('aria-hidden') !== 'true');
}

// 当前真正显示在屏幕上的弹窗栈顶（showModal 是替换语义，栈里可能残留已移除的弹窗）
function currentModal() {
  for (let i = modalStack.length - 1; i >= 0; i--) {
    const m = modalStack[i];
    if (m && m.dialog && m.dialog.isConnected) return m;
  }
  return null;
}

// 该弹窗能否被 ESC / 点遮罩关闭。以入栈时的记录为准，
// 兜底读 data-dismissible（直接写 DOM 的调用方式也能生效）。默认「可关」。
function modalDismissible(entry) {
  const m = entry || currentModal();
  if (!m) return true;
  if (typeof m.dismissible === 'boolean') return m.dismissible;
  return m.dialog.getAttribute('data-dismissible') !== 'false';
}

function focusIntoDialog(dialog) {
  const list = dialogFocusables(dialog);
  const target = list[0] || dialog;
  try { target.focus(); } catch (e) { /* 忽略 focus 异常 */ }
}

// 打开一个弹窗：入栈 + 焦点移入。inheritTrigger 用于「弹窗里再开弹窗」
// dismissible = false 表示需应答弹窗（ESC / 点遮罩都不关闭）
function trapFocus(dialog, inheritTrigger, dismissible) {
  if (!dialog) return;
  const prev = modalStack[modalStack.length - 1];
  const trigger = inheritTrigger || (prev && prev.trigger) ||
    (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  // showModal 会整体替换 modalRoot：旧弹窗 DOM 已消失，先出栈再入栈
  if (prev && !prev.dialog.isConnected) modalStack.pop();
  modalStack.push({ dialog, trigger, dismissible: dismissible !== false });
  focusIntoDialog(dialog);
}

// 关闭栈顶弹窗：把焦点交还上层弹窗，或在栈空时还原到最初的触发元素
function releaseFocus() {
  const top = modalStack.pop();
  if (!top) return;
  // showModal 是替换语义，栈里可能残留已被移除的弹窗 → 一并丢弃
  while (modalStack.length && !modalStack[modalStack.length - 1].dialog.isConnected) modalStack.pop();
  const prev = modalStack[modalStack.length - 1];
  if (prev) { focusIntoDialog(prev.dialog); return; }
  const trigger = top.trigger && top.trigger.isConnected ? top.trigger : null;
  if (trigger && typeof trigger.focus === 'function') {
    try { trigger.focus(); } catch (e) { /* 元素不可聚焦则忽略 */ }
  }
}

// 弹窗内的键盘行为：ESC 关闭（仅可关弹窗）/ Tab 循环 / 空格回车不再触发全局快捷键
function handleModalKeys(e) {
  const top = modalStack[modalStack.length - 1];
  if (!top || !top.dialog.isConnected) return;
  const dialog = top.dialog;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation(); // 避免同时命中全局快捷键里已有的 ESC 逻辑（含 ended 态刷新）
    if (!modalDismissible(top)) {
      nudgeModal(dialog);        // 需应答弹窗：ESC 不关闭，给一次轻提示
      return;
    }
    hideModal();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const list = dialogFocusables(dialog);
    if (!list.length) { dialog.focus(); return; }
    const idx = list.indexOf(document.activeElement);
    const next = idx < 0
      ? (e.shiftKey ? list.length - 1 : 0)
      : (idx + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    try { list[next].focus(); } catch (err) { /* ignore */ }
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && dialog.contains(e.target)) {
    // 交给弹窗内控件自己处理，不再落到全局掷骰/交易快捷键
    e.stopImmediatePropagation();
  }
}
document.addEventListener('keydown', handleModalKeys);

// 让 div 类自定义可点击元素支持键盘（Enter / Space）激活
function makeKeyboardActivatable(el, handler) {
  if (!el) return el;
  el.setAttribute('tabindex', '0');
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();     // 阻止空格滚动页面
      e.stopPropagation();    // 阻止冒泡到全局快捷键
      handler(e);
    }
  });
  return el;
}

function setAriaExpanded(el, expanded) {
  if (el) el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

// dismissible = false：需应答弹窗（购地确认 / 交易 / 购地提案 / 拍卖应答），
// ESC、点遮罩、右上 × 都不会关闭，只能走弹窗内的应答按钮或服务端超时。
// 默认 true：纯信息弹窗（帮助 / 设置 / 趋势 / 回放 / 总览）可关。
function showModal(title, html, footer = '', dismissible = true) {
  const canClose = dismissible !== false;
  els.modalRoot.innerHTML = `
    <div class="modal">
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="${MODAL_TITLE_ID}" tabindex="-1" data-dismissible="${canClose ? 'true' : 'false'}">
        <div class="modal-header">
          <div class="modal-title" id="${MODAL_TITLE_ID}">${title}</div>
          <button class="modal-close" aria-label="关闭弹窗" onclick="modalCloseRequest()">×</button>
        </div>
        <div class="modal-body">${html}</div>
        <div class="modal-footer">${footer}</div>
      </div>
    </div>
  `;
  const overlay = els.modalRoot.querySelector('.modal');
  const dialog = els.modalRoot.querySelector('.modal-content');
  // 遮罩点击：可关的直接关闭；不可关的给一次抖动 + toast 反馈
  if (overlay && dialog) {
    overlay.addEventListener('click', e => {
      if (e.target !== overlay) return; // 只处理点在遮罩本身上的点击，弹窗内部点击不算
      if (modalDismissible()) hideModal();
      else nudgeModal(dialog);
    });
  }
  trapFocus(dialog, undefined, canClose);
}

// 右上角 × ：与 ESC 同一套白名单语义
function modalCloseRequest() {
  if (modalDismissible()) hideModal();
  else nudgeModal();
}

// 轻提示「这个弹窗需要你应答」：位移抖动（不依赖 CSS）+ toast
function nudgeModal(dialog) {
  const target = dialog || (currentModal() && currentModal().dialog);
  if (!target) return;
  try {
    const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion && typeof target.animate === 'function') {
      target.animate([
        { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' },
        { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' }, { transform: 'translateX(0)' },
      ], { duration: 240, easing: 'ease-in-out' });
    }
  } catch (e) { /* 动画不可用时只留 toast */ }
  toast('请先完成当前操作', 'info');
}

function hideModal() {
  releaseFocus();
  els.modalRoot.innerHTML = '';
}
window.hideModal = hideModal;
window.modalCloseRequest = modalCloseRequest;
window.trapFocus = trapFocus;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function isMyTurn() {
  const g = state.game;
  return !!g && g.started && !g.ended && g.order[g.turnIndex] === state.myToken;
}

// ────────────────────────────────────────────────────────────
// IDENTITY (token survives page refresh / reconnect)
// ────────────────────────────────────────────────────────────
function getToken() {
  let t = localStorage.getItem('monopoly_token');
  if (!t) {
    t = 'u' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('monopoly_token', t);
  }
  return t;
}

function getName() {
  return localStorage.getItem('monopoly_name') || ('玩家' + Math.floor(Math.random() * 1000));
}

function getRoom() {
  return localStorage.getItem('monopoly_room') || 'room1';
}

// ────────────────────────────────────────────────────────────
// VIEW SWITCHING (lobby <-> game)
// ────────────────────────────────────────────────────────────
function showView(view) {
  state.view = view;
  if (view === 'lobby') {
    els.mainApp.classList.add('hidden');
    els.lobby.classList.remove('hidden');
  } else {
    els.lobby.classList.add('hidden');
    els.mainApp.classList.remove('hidden');
  }
  // 「跳到主内容」的目标随视图变化，否则会跳到被隐藏的 <main>
  const skip = document.querySelector('.skip-link');
  if (skip) skip.setAttribute('href', view === 'lobby' ? '#lobby' : '#mainContent');
}

// ────────────────────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────────────────────
function init() {
  state.myToken = getToken();

  setupEventListeners();
  setupKeyboardShortcuts();
  renderAvatarGrid();
  els.lobbyName.value = localStorage.getItem('monopoly_name') || '';
  els.joinRoomInput.value = localStorage.getItem('monopoly_room') || '';
  syncVersion();
  showView('lobby');
  socket.emit('getRooms');
  socket.emit('getStats', { name: localStorage.getItem('monopoly_name') || '' });
  handleInviteParam();
  setInterval(() => { if (state.view === 'lobby') socket.emit('getRooms'); }, 5000);
  // 回合倒计时/拍卖倒计时每秒刷新
  setInterval(() => {
    if (state.view !== 'game') return;
    updateTurnTimer();
    if (state.game?.auction) renderAuction();
    // 交易提议倒计时
    const cdEl = document.getElementById('tradeCd');
    if (cdEl) {
      const t = state.game && state.game.trade;
      if (t) cdEl.textContent = String(Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000)));
      else cdEl.textContent = '0';
    }
    // 本局用时每秒走字
    const bcRound = document.querySelector('.bc-round');
    if (bcRound && state.game && state.game.startedAt && !state.game.ended) {
      const s = Math.max(0, Math.floor((Date.now() - state.game.startedAt) / 1000));
      const t = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      bcRound.innerHTML = bcRound.innerHTML.replace(/已用 [0-9:]+/, '已用 ' + t);
    }
  }, 1000);

  setTimeout(() => {
    els.loading.style.opacity = '0';
    setTimeout(() => {
      els.loading.classList.add('hidden');
      showView(state.view);
    }, 400);
  }, 800);
}

function saveLobbyIdentity() {
  const name = (els.lobbyName.value || '').trim();
  if (name) localStorage.setItem('monopoly_name', name.slice(0, 16));
  if (state.selectedAvatar) localStorage.setItem('monopoly_avatar', state.selectedAvatar);
}

function joinRoom(roomId) {
  roomId = String(roomId || '').trim().slice(0, 24);
  if (!roomId) { toast('请输入房间号', 'error'); return; }
  saveLobbyIdentity();
  state.myToken = getToken();
  state.victoryShown = false;
  state.game = null;
  localStorage.setItem('monopoly_room', roomId);
  const pwdInput = document.getElementById('joinPwdInput');
  socket.emit('join', {
    roomId,
    name: localStorage.getItem('monopoly_name') || getName(),
    avatar: localStorage.getItem('monopoly_avatar') || PLAYER_AVATARS[0],
    token: state.myToken,
    password: pwdInput && pwdInput.value ? pwdInput.value.trim() : undefined,
  });
  if (pwdInput) pwdInput.value = '';
}

function goBackToLobby() {
  const g = state.game;
  const me = g?.players?.[state.myToken];
  if (g && g.started && !g.ended && me && !me.bankrupt && !me.isBot) {
    // 对局中离开：确认后由机器人接管席位
    showModal(
      '🚪 退出房间？',
      `<p style="font-size:14px;line-height:1.7;">退出后你的席位将由 <b>🤖 机器人接管</b>（资产保留，AI 替你继续玩）。<br>回到该房间即可收回控制权。</p>`,
      `<button class="btn btn-sm btn-danger" onclick="doLeaveRoom()">确认退出</button>
       <button class="btn btn-sm btn-ghost" onclick="hideModal()">继续游戏</button>`
    );
    return;
  }
  if (state.game) socket.emit('leave');
  state.game = null;
  state.selectedProp = null;
  hideModal();
  els.chatInput.value = '';
  localStorage.removeItem('monopoly_room');
  els.joinRoomInput.value = '';
  syncVersion();
  showView('lobby');
  socket.emit('getRooms');
  socket.emit('getStats', { name: localStorage.getItem('monopoly_name') || '' });
  handleInviteParam();
}

window.doLeaveRoom = function() {
  hideModal();
  if (state.game) socket.emit('leave');
  state.game = null;
  state.selectedProp = null;
  state.victoryShown = false;
  hideModal();
  els.chatInput.value = '';
  localStorage.removeItem('monopoly_room');
  els.joinRoomInput.value = '';
  syncVersion();
  showView('lobby');
  socket.emit('getRooms');
  socket.emit('getStats', { name: localStorage.getItem('monopoly_name') || '' });
  handleInviteParam();
};

function confirmExit() {
  const g = state.game;
  if (!g) { window.doLeaveRoom(); return; }
  if (!g.started || g.ended) { window.doLeaveRoom(); return; }
  const me = g.players?.[state.myToken];
  if (!me || me.bankrupt || me.isBot) { window.doLeaveRoom(); return; }
  showModal(
    '🚪 退出房间？',
    `<p style="font-size:14px;line-height:1.7;">你正在游戏中。退出后 <b>🤖 机器人会替你继续玩</b>（资产保留）。<br>之后进入同一房间即可收回控制权。<br><span style="color:var(--text-tertiary);font-size:12px;">提示：只是临时离开可改用「🕹 托管」，留在房间随时接管。</span></p>`,
    `<button class="btn btn-sm btn-danger" onclick="doLeaveRoom()">确认退出</button>
     <button class="btn btn-sm btn-primary" onclick="hideModal();socket.emit('toggleDelegation')">🕹 改用托管</button>
     <button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>`
  );
}
window.confirmExit = confirmExit;

function copyInviteLink() {
  const rid = state.game && state.game.id;
  if (!rid) return;
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(rid);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('邀请链接已复制，发给朋友打开直接进房', 'success'))
      .catch(() => showInviteFallback(url));
  } else {
    showInviteFallback(url);
  }
}

function showInviteFallback(url) {
  showModal(
    '📋 邀请链接',
    `<p class="code-block">${escapeHtml(url)}</p>
     <p style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">复制上面的链接发给朋友，打开即可直接进房。</p>`,
    `<button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>`
  );
}

// URL ?room=xxx：识别邀请链接自动进房
function handleInviteParam() {
  let room = null;
  try { room = new URLSearchParams(location.search).get('room'); } catch (e) {}
  if (!room) return;
  const clean = String(room).slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return;
  els.joinRoomInput.value = clean;
  if (localStorage.getItem('monopoly_name')) {
    joinRoom(clean);
    toast('已按邀请链接自动加入房间 ' + clean, 'success');
  } else {
    toast('邀请链接已识别：输入昵称点「加入」即可进房 ' + clean, 'info');
  }
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}

function soloQuickStart() {
  let roomId;
  do {
    roomId = 'r' + Math.random().toString(36).substring(2, 7);
  } while (lastRooms.some(r => r.id === roomId));
  saveLobbyIdentity();
  state.myToken = getToken();
  state.victoryShown = false;
  state.game = null;
  localStorage.setItem('monopoly_room', roomId);
  socket.emit('join', {
    roomId,
    name: localStorage.getItem('monopoly_name') || getName(),
    avatar: localStorage.getItem('monopoly_avatar') || PLAYER_AVATARS[0],
    token: state.myToken,
  });
  socket.emit('addBot', { difficulty: 'normal' });
  socket.emit('addBot', { difficulty: 'normal' });
  socket.emit('addBot', { difficulty: 'normal' });
  socket.emit('start');
  toast('已自动建房并添加 3 个机器人，开局！', 'success');
}

function createNewRoom() {
  let roomId;
  do {
    roomId = 'r' + Math.random().toString(36).substring(2, 7);
  } while (lastRooms.some(r => r.id === roomId));
  joinRoom(roomId);
}

function renderAvatarGrid() {
  if (!els.avatarGrid) return;
  const current = localStorage.getItem('monopoly_avatar') || PLAYER_AVATARS[0];
  state.selectedAvatar = current;
  els.avatarGrid.innerHTML = '';
  els.avatarGrid.setAttribute('role', 'radiogroup');
  const pickAvatar = (a, d) => {
    state.selectedAvatar = a;
    els.avatarGrid.querySelectorAll('.avatar-option').forEach(x => {
      x.classList.remove('selected');
      x.setAttribute('aria-checked', 'false');
    });
    d.classList.add('selected');
    d.setAttribute('aria-checked', 'true');
  };
  PLAYER_AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'avatar-option' + (a === current ? ' selected' : '');
    d.textContent = a;
    d.setAttribute('role', 'radio');
    d.setAttribute('aria-checked', a === current ? 'true' : 'false');
    d.setAttribute('aria-label', '使用头像 ' + a);
    makeKeyboardActivatable(d, () => pickAvatar(a, d));
    d.onclick = () => pickAvatar(a, d);
    els.avatarGrid.appendChild(d);
  });
}

function sendChat() {
  const text = els.chatInput.value.trim();
  if (text && state.game) socket.emit('chat', text);
  els.chatInput.value = '';
}

function setupEventListeners() {
  // Lobby
  els.lobbyCreateBtn?.addEventListener('click', () => createNewRoom());
  els.joinRoomBtn?.addEventListener('click', () => joinRoom(els.joinRoomInput.value));
  els.joinRoomInput?.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(els.joinRoomInput.value); });
  els.refreshRoomsBtn?.addEventListener('click', () => socket.emit('getRooms'));

  // Game view
  els.backBtn?.addEventListener('click', () => goBackToLobby());
  els.sendChatBtn?.addEventListener('click', () => sendChat());
  els.chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  els.startBtn?.addEventListener('click', () => socket.emit('start'));
  els.rollBtn?.addEventListener('click', () => socket.emit('roll'));
  els.bailBtn?.addEventListener('click', () => socket.emit('payBail'));
  els.buyBtn?.addEventListener('click', () => socket.emit('buy'));
  els.buildBtn?.addEventListener('click', () => toggleBuildMode());
  els.mortgageBtn?.addEventListener('click', () => toggleMortgageMode());
  els.endTurnBtn?.addEventListener('click', () => socket.emit('endTurn'));
  els.delegateBtn?.addEventListener('click', () => socket.emit('toggleDelegation'));
  els.exitBtn?.addEventListener('click', () => confirmExit());
  els.maxRoundsSel?.addEventListener('change', () => {
    socket.emit('setMaxRounds', { value: Number(els.maxRoundsSel.value) });
  });
  els.inviteBtn?.addEventListener('click', () => copyInviteLink());
  els.chartBtn?.addEventListener('click', () => openNwChart());
  els.overviewBtn?.addEventListener('click', () => openAssetsOverview());
  els.replayBtn?.addEventListener('click', () => openReplay());
  document.querySelectorAll('#quickReactions button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.game) socket.emit('chat', btn.dataset.emoji);
    });
  });
  els.startMoneySel?.addEventListener('change', () => socket.emit('setSettings', { startMoney: Number(els.startMoneySel.value) }));
  els.mapSel?.addEventListener('change', () => socket.emit('setSettings', { map: els.mapSel.value }));
  els.turnTimeSel?.addEventListener('change', () => socket.emit('setSettings', { turnTimeoutMs: Number(els.turnTimeSel.value) }));
  els.teamModeChk?.addEventListener('change', () => socket.emit('setSettings', { teamMode: els.teamModeChk.checked }));
  els.botSpeedSel?.addEventListener('change', () => socket.emit('setSettings', { botSpeed: Number(els.botSpeedSel.value) }));
  els.lobbySoloBtn?.addEventListener('click', () => soloQuickStart());
  els.jackpotChk?.addEventListener('change', () => socket.emit('setSettings', { jackpotOn: els.jackpotChk.checked }));
  els.auctionChk?.addEventListener('change', () => socket.emit('setSettings', { auctionOn: els.auctionChk.checked }));

  // 拍卖出价
  const bid = step => {
    const a = state.game?.auction;
    if (!a) return;
    socket.emit('auctionBid', { amount: a.topBid + step });
  };
  els.apBid100?.addEventListener('click', () => bid(100));
  els.apBid500?.addEventListener('click', () => bid(500));
  els.apBid1000?.addEventListener('click', () => bid(1000));
  els.apHideBtn?.addEventListener('click', () => {
    const a = state.game?.auction;
    if (a) state.auctionHiddenNo = a.no;
    els.auctionPanel.classList.add('hidden');
    setAriaExpanded(els.apHideBtn, false);
  });
  els.tradeBtn?.addEventListener('click', () => openTradeModal());
  els.botBtn?.addEventListener('click', () => openBotModal());
  els.settingsBtn?.addEventListener('click', () => openSettings());
  els.helpBtn?.addEventListener('click', () => openHelp());
  els.helpBtnLobby?.addEventListener('click', () => openHelp());
  els.themeBtn?.addEventListener('click', () => Theme.toggle());
  els.themeBtnLobby?.addEventListener('click', () => Theme.toggle());

  els.zoomIn?.addEventListener('click', () => changeZoom(0.1));
  els.zoomOut?.addEventListener('click', () => changeZoom(-0.1));
  els.zoomReset?.addEventListener('click', () => setZoom(1));
  els.logFilter?.addEventListener('change', () => {
    state.logFilter = els.logFilter.value;
    renderLog();
  });
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    // 弹窗打开中：h（帮助叠帮助）与 T（误改主题）一律忽略
    const modalOpen = !!currentModal();
    if (!modalOpen) {
      if (e.key === 'h' || e.key === 'H') { if (!e.repeat) openHelp(); return; }
      if (e.key === 'T' && !e.repeat) { Theme.toggle(); return; }
    }
    if (state.game?.ended) {
      if (e.key === 'Escape') window.location.reload();
      if (e.key === 'Enter') { e.preventDefault(); socket.emit('reset'); }
      return;
    }
    // 弹窗打开中屏蔽所有会操作对局的快捷键（空格掷骰 / b 购地 / e 结束回合 /
    // t 交易 / p 交保释金 / 1·2·3 拍卖加价），避免在帮助等弹窗里误触
    if (modalOpen) return;

    const myTurn = isMyTurn() && !state.game.diceAnim;
    switch (e.key.toLowerCase()) {
      case ' ':
        if (myTurn) { e.preventDefault(); socket.emit('roll'); }
        break;
      case 'b':
        if (myTurn) { e.preventDefault(); socket.emit('buy'); }
        break;
      case 'e':
        if (myTurn) { e.preventDefault(); socket.emit('endTurn'); }
        break;
      case 't':
        if (myTurn) { e.preventDefault(); openTradeModal(); }
        break;
      case 'p':
        if (myTurn) { e.preventDefault(); socket.emit('payBail'); }
        break;
      case '1':
      case '2':
      case '3': {
        const a = state.game && state.game.auction;
        if (a) {
          e.preventDefault();
          socket.emit('auctionBid', { amount: a.topBid + [100, 500, 1000][Number(e.key) - 1] });
        }
        break;
      }
    }
  });
}

// ────────────────────────────────────────────────────────────
// RENDER: BOARD  (server pos is {r, c}, 1-based grid 11x11)
// ────────────────────────────────────────────────────────────
// 回放模式下返回由快照重建的"视图态"，否则返回直播态
function displayGame() {
  const g = state.game;
  if (state.replayIdx === null || !g || !g.replay || !g.replay.length) return g;
  const snap = g.replay[Math.min(state.replayIdx, g.replay.length - 1)];
  if (!snap) return g;
  const view = { ...g, isReplay: true, replayRound: snap.r };
  view.board = g.board.map((c, i) => {
    const s = snap.c[i] || [0, 0, 0];
    return { ...c, owner: s[0] || null, level: s[1] || 0, mortgaged: !!s[2], rent: 0 };
  });
  view.players = {};
  g.order.forEach(pid => {
    const live = g.players[pid];
    if (!live) return;
    const s = snap.p[pid] || [0, 0, 1];
    view.players[pid] = { ...live, pos: s[0], money: s[1], bankrupt: !!s[2] };
  });
  view.order = g.order.filter(pid => view.players[pid]);
  return view;
}

function fmtElapsed(from) {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function computeMonopolies() {
  // 返回 { group: ownerId } —— 被同一位玩家集齐的色系
  const map = {};
  if (!state.game) return map;
  const byGroup = {};
  state.game.board.forEach(c => {
    if (c.type === 'city' && c.group && c.owner) {
      (byGroup[c.group] = byGroup[c.group] || []).push(c.owner);
    }
  });
  Object.entries(byGroup).forEach(([g, owners]) => {
    if (owners.length >= 2 && owners.every(o => o === owners[0])) map[g] = owners[0];
  });
  return map;
}

// 首次为单个格子建立「常驻骨架」：静态子节点 + 三个动态徽标（隐藏态）
function buildCellSkeleton(cell) {
  const div = document.createElement('div');
  div.className = `cell ${cell.type}`;
  // 服务器 pos 为 0-based (0~10)，CSS Grid 线为 1-based (1~11)，必须 +1
  div.style.gridColumn = cell.pos.c + 1;
  div.style.gridRow = cell.pos.r + 1;
  div.dataset.cellId = cell.id;
  if ([0, 10, 20, 30].includes(cell.id)) div.classList.add('corner');

  // Group color strip on the edge facing board center
  if (cell.group) {
    const strip = document.createElement('div');
    strip.className = 'color-strip';
    strip.style.background = GROUP_META[cell.group]?.color || '#ccc';
    const r = cell.pos.r, c = cell.pos.c;
    if (r === 10) strip.classList.add('strip-top');
    else if (r === 0) strip.classList.add('strip-bottom');
    else if (c === 0) strip.classList.add('strip-right');
    else strip.classList.add('strip-left');
    div.appendChild(strip);
  }

  // Icon for special cells
  if (ICONS_META[cell.type] && cell.type !== 'city') {
    const icon = document.createElement('div');
    icon.className = 'cell-icon';
    icon.textContent = ICONS_META[cell.type];
    div.appendChild(icon);
  }

  // Name
  const nameEl = document.createElement('div');
  nameEl.className = 'cell-name';
  nameEl.textContent = cell.name;
  div.appendChild(nameEl);

  if (cell.type === 'casino') {
    const sub = document.createElement('div');
    sub.className = 'cell-price';
    sub.textContent = '赌一把';
    div.appendChild(sub);
  }

  // Price
  let priceEl = null;
  if (cell.price > 0) {
    priceEl = document.createElement('div');
    priceEl.className = 'cell-price';
    priceEl.textContent = `¥${(cell.price / 100) % 1 === 0 ? cell.price / 100 : cell.price}`;
    div.appendChild(priceEl);
  }

  // 动态节点常驻（初始隐藏，patch 时开关）：house / owner / rent
  const house = document.createElement('div');
  house.className = 'house-badge';
  div.appendChild(house);

  const dot = document.createElement('div');
  dot.className = 'owner-dot';
  div.appendChild(dot);

  const rent = document.createElement('div');
  rent.className = 'rent-badge';
  div.appendChild(rent);

  // 点击/键盘打开地产详情
  div.setAttribute('role', 'button');
  div.setAttribute('aria-label', cell.name + '，查看地产详情');
  makeKeyboardActivatable(div, () => openPropertyModal(cell.id));
  div.onclick = () => openPropertyModal(cell.id);

  const entry = { el: div, name: nameEl, price: priceEl, house, dot, rent, sig: cellStaticSig(cell) };
  boardCells[cell.id] = entry;
  return entry;
}

// patch 一个已存在格子的动态部分（owner/level/mortgage/rent/高亮/垄断），不重建节点
function applyCellDynamic(entry, cell, monopolies) {
  const div = entry.el;
  cellVisible(entry.house, cell.type === 'city' && cell.level > 0);
  if (cell.type === 'city' && cell.level > 0) {
    entry.house.textContent = cell.level >= 5 ? '🏨' : '🏠'.repeat(cell.level);
  }
  cellVisible(entry.dot, !!cell.owner);
  if (cell.owner) entry.dot.style.background = playerColor(cell.owner);

  const showRent = !!(cell.owner && !cell.mortgaged &&
    (cell.type === 'city' || cell.type === 'railroad' || cell.type === 'utility'));
  cellVisible(entry.rent, showRent);
  if (showRent) entry.rent.textContent = (cell.rent === -1) ? '骰×40' : '¥' + cell.rent;

  div.classList.toggle('mortgaged', !!cell.mortgaged);

  div.classList.toggle('cell-flash', !!(state.flashCells && state.flashCells.includes(cell.id)));
  div.classList.toggle('cell-gold', !!(state.goldCells && state.goldCells.includes(cell.id)));
  div.classList.toggle('cell-auction', !!(state.game.auction && state.game.auction.cellId === cell.id));
  if (cell.group && monopolies[cell.group]) {
    div.classList.add('monopoly-cell');
    div.style.setProperty('--mono-color', playerColor(monopolies[cell.group]));
  } else {
    div.classList.remove('monopoly-cell');
    div.style.removeProperty('--mono-color');
  }

  div.title = cellTitle(cell);
  div.setAttribute('aria-label', cellTitle(cell) + '，查看地产详情');
}

function renderBoard() {
  const g = displayGame();
  if (!state.game) return;
  // tokenLayer 保留以支持移动过渡动画，绝不清理

  const monopolies = computeMonopolies();
  g.board.forEach(cell => {
    const entry = boardCells[cell.id];
    if (!entry) {
      // 首次：建骨架并挂载（append 顺序与旧全量重建一致：tokenLayer → 格子 → 中央面板）
      const fresh = buildCellSkeleton(cell);
      applyCellDynamic(fresh, cell, monopolies);
      els.board.appendChild(fresh.el);
    } else if (entry.sig !== cellStaticSig(cell)) {
      // 静态签名变化（换地图 / 改名 / 改类型 / 改价格）→ 仅重建该格
      const fresh = buildCellSkeleton(cell);
      applyCellDynamic(fresh, cell, monopolies);
      entry.el.replaceWith(fresh.el);
      boardCells[cell.id] = fresh;
    } else {
      // 常态：只 patch 动态状态，节点原样复用
      applyCellDynamic(entry, cell, monopolies);
    }
  });

  // 移除已不存在的格子（换地图后格子数变少等异常情况）
  const aliveIds = new Set(g.board.map(c => c.id));
  Object.keys(boardCells).forEach(id => {
    if (aliveIds.has(Number(id))) return;
    const e = boardCells[id];
    if (e && e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
    delete boardCells[id];
  });

  // ── 棋盘中央信息面板：仅内容变化才重建 ──
  renderBoardCenter(g);

  renderTokens();
}

// 中央信息面板（显式定位在 11×11 网格中心：行2-10 列2-10），仅在内容变化时更新 innerHTML
function renderBoardCenter(stateGame) {
  const dice = stateGame.dice;
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const cur = stateGame.players[stateGame.order[stateGame.turnIndex]];
  let turnLine = '等待开始';
  if (stateGame.started) {
    if (stateGame.ended) turnLine = '🏁 已结束';
    else turnLine = `轮到 ${cur ? (cur.avatar + ' ' + escapeHtml(cur.name)) : '...'}${cur && cur.isBot ? ' 🤖' : ''}`;
  }
  const html = `
    <div class="bc-logo">MONOPOLY</div>
    <div class="bc-sub">大富翁在线</div>
    <div class="bc-dice">${dice ? `${faces[dice[0] - 1]}${faces[dice[1] - 1]} <b>${dice[0] + dice[1]}</b>` : '🎲🎲'}</div>
    <div class="bc-turn">${turnLine}</div>
    <div class="bc-round">第 ${stateGame.roundCount || 1}${stateGame.maxRounds ? '/' + stateGame.maxRounds : ''} 回合 · ${stateGame.order.length} 人${stateGame.startedAt ? ' · 已用 ' + fmtElapsed(stateGame.startedAt) : ''}${state.replayIdx !== null ? ' · 🎥 回放中' : ''}</div>
    ${stateGame.jackpot > 0 ? `<div class="bc-jackpot">🎁 停车场奖池 ¥${stateGame.jackpot.toLocaleString()}</div>` : ''}
  `;
  if (!boardCenterEl || boardCenterEl.parentNode !== els.board || boardCenterHtml !== html) {
    if (boardCenterEl && boardCenterEl.parentNode) boardCenterEl.parentNode.removeChild(boardCenterEl);
    boardCenterEl = document.createElement('div');
    boardCenterEl.className = 'board-center';
    boardCenterEl.style.gridArea = '2 / 2 / 11 / 11';
    boardCenterEl.innerHTML = html;
    els.board.appendChild(boardCenterEl);
    boardCenterHtml = html;
  }
}

// ────────────────────────────────────────────────────────────
// TOKEN LAYER（棋子持久化 + 平滑移动动画）
// ────────────────────────────────────────────────────────────
const TOKEN_HOP_MS = 95;   // 逐格跳动的间隔
const TOKEN_MAX_HOPS = 12; // 超过此跳数视为传送，直接滑动

function tokenCellStyle(cellId, pid) {
  const cell = state.game.board[cellId];
  if (!cell) return null;
  const idx = state.game.order.indexOf(pid);
  const n = Math.max(1, state.game.order.length);
  const off = (idx - (n - 1) / 2) * 2.4;
  return {
    left: (((cell.pos.c + 0.5) / 11) * 100 + off) + '%',
    top: (((cell.pos.r + 0.5) / 11) * 100 + off * 0.55) + '%',
  };
}

function placeToken(el, cellId, pid, duration) {
  const st = tokenCellStyle(cellId, pid);
  if (!st) return;
  if (duration) el.style.transitionDuration = duration;
  el.style.left = st.left;
  el.style.top = st.top;
}

function renderTokens() {
  const layer = els.tokenLayer;
  if (!layer || !state.game) return;
  const seen = new Set();

  state.game.order.forEach(pid => {
    const p = state.game.players[pid];
    if (!p || p.bankrupt) return;
    seen.add(pid);

    let el = layer.querySelector(`[data-pid="${pid}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.pid = pid;
      el.className = 'gtoken' + (pid === state.myToken ? ' me' : '');
      el.style.transition = 'none'; // 首次出现不播放动画
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', p.name + ' 的棋子，查看资产总览');
      makeKeyboardActivatable(el, () => openPlayerModal(pid));
      el.addEventListener('click', () => openPlayerModal(pid));
      layer.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
      el.dataset.dispPos = String(p.pos);
      placeToken(el, p.pos, pid, '0s');
    }
    el.style.background = playerColor(pid);
    el.textContent = p.avatar || p.name.charAt(0);
    el.title = p.name + (pid === state.myToken ? ' (我)' : '');
    el.setAttribute('aria-label', p.name + (pid === state.myToken ? '（我）' : '') + ' 的棋子，查看资产总览');

    const disp = parseInt(el.dataset.dispPos ?? String(p.pos), 10);
    if (disp === p.pos) return;

    // 有新目标：打断进行中的动画，从当前显示位置重新规划
    if (el._hopTimer) { clearTimeout(el._hopTimer); el._hopTimer = null; }
    const hops = (p.pos - disp + 40) % 40;
    if (hops === 0) return;
    if (hops > TOKEN_MAX_HOPS) {
      // 传送（入狱/原地大挪移）：一次平滑滑动
      el.dataset.dispPos = String(p.pos);
      placeToken(el, p.pos, pid, '0.55s');
      return;
    }
    // 逐格前进
    el.style.transitionDuration = '0.09s';
    el.style.transitionTimingFunction = 'linear';
    let cur = disp;
    const stepFn = () => {
      cur = (cur + 1) % 40;
      el.dataset.dispPos = String(cur);
      placeToken(el, cur, pid, '0.09s');
      if (cur !== p.pos) {
        el._hopTimer = setTimeout(stepFn, TOKEN_HOP_MS);
      } else {
        el._hopTimer = null;
        el.style.transitionTimingFunction = '';
      }
    };
    el._hopTimer = setTimeout(stepFn, TOKEN_HOP_MS);
  });

  layer.querySelectorAll('.gtoken').forEach(el => {
    if (!seen.has(el.dataset.pid)) {
      if (el._hopTimer) clearTimeout(el._hopTimer);
      el.remove();
    }
  });
}

// ────────────────────────────────────────────────────────────
// 玩家资产总览
// ────────────────────────────────────────────────────────────
function openPlayerModal(pid) {
  const g = state.game;
  const p = g && g.players[pid];
  if (!p) return;
  const props = (p.properties || []).map(id => g.board[id]).filter(Boolean).sort((a, b) => a.id - b.id);
  const propVal = props.reduce((s, c) => s + (c.price || 0), 0);
  const net = p.money + propVal;
  const rows = props.map(c => `
    <div class="pm-prop">
      <span class="pm-chip" style="background:${GROUP_META[c.group] ? GROUP_META[c.group].color : '#888'}"></span>
      <span class="pm-name">${escapeHtml(c.name)}</span>
      <span class="pm-meta">${c.mortgaged ? '🏦已抵押' : c.type === 'city' ? (c.level >= 5 ? '🏨酒店' : (c.level ? '🏠'.repeat(c.level) : '空地')) : ''}</span>
    </div>`).join('') || '<p style="color:var(--text-tertiary);font-size:13px;">暂无地产</p>';

  const isTradeable = pid !== state.myToken && !p.isBot;
  showModal(
    `${p.avatar} ${escapeHtml(p.name)}${p.isBot ? ' <span class="bot-tag">BOT</span>' : ''}${p.id === state.myToken ? '（我）' : ''}${pid === g.hostToken ? ' 👑' : ''}`,
    `
      <div style="font-size:14px;line-height:1.8;">
        <p>💰 现金：<b>${formatMoney(p.money)}</b> ｜ 🏘 地产：<b>${props.length} 块</b>（估值 ¥${propVal.toLocaleString()}）</p>
        <p>📊 净资产：<b style="color:var(--accent-warning);">${formatMoney(net)}</b>${p.jailTurns > 0 ? ` ｜ 🔒 狱中 ${p.jailTurns} 回合` : ''}${p.delegated ? ' ｜ 🕹 托管中' : ''}${!p.connected && !p.isBot ? ' ｜ 💤 掉线' : ''}${p.bankrupt ? ' ｜ 💀 已破产' : ''}</p>
        <p style="font-size:12px;color:var(--text-tertiary);">🏦 租金收入 ¥${(p.rentEarned || 0).toLocaleString()} ｜ 租金支出 ¥${(p.rentPaid || 0).toLocaleString()}</p>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;">${rows}</div>
      </div>
    `,
    `
      ${isTradeable && !p.bankrupt ? `<button class="btn btn-sm btn-primary" onclick="hideModal();selectTradeTarget('${pid}')">🤝 与 TA 交易</button>` : ''}
      <button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>
    `
  );
}
window.openPlayerModal = openPlayerModal;

function canBuildHere(cellId) {
  const g = state.game;
  const cell = g.board[cellId];
  if (!cell || cell.type !== 'city' || cell.owner !== state.myToken || cell.mortgaged) return false;
  const sameGroup = g.board.filter(c => c.group === cell.group);
  if (!sameGroup.every(c => c.owner === state.myToken)) return false;
  const minLevel = Math.min(...sameGroup.map(c => c.level));
  return cell.level === minLevel && cell.level < 5;
}

function canSellHere(cellId) {
  const g = state.game;
  const cell = g.board[cellId];
  if (!cell || cell.type !== 'city' || cell.owner !== state.myToken || cell.level <= 0) return false;
  const maxLevel = Math.max(...g.board.filter(c => c.group === cell.group).map(c => c.level));
  return cell.level >= maxLevel;
}

function openPropertyModal(cellId) {
  if (!state.game) return;
  const cell = state.game.board[cellId];
  if (!cell) return;
  state.selectedProp = cellId;

  const meta = GROUP_META[cell.group];
  const owner = cell.owner ? state.game.players[cell.owner] : null;
  const mine = cell.owner === state.myToken;
  const onIt = state.game.players[state.myToken]?.pos === cellId && isMyTurn();

  // Rent preview
  let rentInfo = '';
  if (meta && cell.type === 'city' && meta.rents.length >= 6) {
    const ownsAll = state.game.board.filter(c => c.group === cell.group).every(c => c.owner === cell.owner && cell.owner);
    rentInfo = `
      <p><strong>租金表：</strong>空地 ¥${Math.round(meta.rents[0] * rentMul()).toLocaleString()}${ownsAll && cell.owner ? '（集齐全组 ×2 = ¥' + (meta.rents[0] * 2).toLocaleString() + '）' : ''}</p>
      <p style="padding-left:12px;">🏠1房 ¥${Math.round(meta.rents[1] * rentMul()).toLocaleString()} · 🏠2房 ¥${Math.round(meta.rents[2] * rentMul()).toLocaleString()} · 🏠3房 ¥${Math.round(meta.rents[3] * rentMul()).toLocaleString()} · 🏠4房 ¥${Math.round(meta.rents[4] * rentMul()).toLocaleString()} · 🏨酒店 ¥${Math.round(meta.rents[5] * rentMul()).toLocaleString()}</p>
      <p><strong>每级建造费：</strong>¥${Math.floor(meta.houseCost * ((state.game && state.game.houseMul) || 1)).toLocaleString()}（出售退一半）</p>
    `;
  } else if (cell.group === 'railroad') {
    rentInfo = `<p><strong>租金：</strong>拥有 1/2/3/4 条铁路 → ¥250 / ¥500 / ¥1000 / ¥2000</p>`;
  } else if (cell.group === 'utility') {
    rentInfo = `<p><strong>租金：</strong>拥有 1 家 = 骰子点数 ×40；2 家 = 骰子点数 ×100</p>`;
  }
  if (cell.owner && !cell.mortgaged && cell.rent !== undefined && cell.rent !== 0) {
    rentInfo += `<p><strong>当前租金：</strong>${cell.rent === -1 ? '骰子点数 ×40/×100' : '¥' + cell.rent.toLocaleString()}</p>`;
  }

  let actions = '';
  if (mine) {
    const canB = canBuildHere(cellId), canS = canSellHere(cellId);
    actions = `
      <button class="btn btn-sm" onclick="manageProperty('build')" ${canB ? '' : 'disabled'}>🏗 建造</button>
      <button class="btn btn-sm" onclick="manageProperty('sell')" ${canS ? '' : 'disabled'}>🔨 出售建筑</button>
      <button class="btn btn-sm btn-warning" onclick="manageProperty('unmortgage')" ${cell.mortgaged ? '' : 'disabled'}>🔓 赎回</button>
      <button class="btn btn-sm btn-secondary" onclick="manageProperty('mortgage')" ${!cell.mortgaged && cell.level === 0 ? '' : 'disabled'}>🏦 抵押</button>
    `;
  }

  // 购地确认态：本人停在该格 + 无主 + 买得起 → 弹窗即「买 / 放弃」的应答入口
  const me = state.game.players[state.myToken];
  const isBuyPrompt = !mine && !cell.owner && onIt && cell.price > 0 && me && me.money >= cell.price;

  showModal(
    `${meta ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${meta.color};vertical-align:middle;"></span> ` : ''}🏘 ${escapeHtml(cell.name)}`,
    `
      <div style="font-size:14px;line-height:1.7;">
        <p><strong>类型：</strong>${cell.type === 'city' ? '地产' : cell.type === 'railroad' ? '铁路' : cell.type === 'utility' ? '公用事业' : '特殊格'}</p>
        ${cell.price > 0 ? `<p><strong>价格：</strong>¥${cell.price.toLocaleString()} | <strong>抵押价：</strong>¥${Math.floor(cell.price * 0.5).toLocaleString()}</p>` : ''}
        ${cell.type === 'city' ? `<p><strong>当前等级：</strong>${cell.level === 0 ? '空地' : cell.level >= 5 ? '🏨 酒店' : '🏠'.repeat(cell.level)}</p>` : ''}
        ${rentInfo}
        <p><strong>所有者：</strong>${owner ? `${owner.avatar} ${escapeHtml(owner.name)}${mine ? '（你）' : ''}` : '无主，可购买'}</p>
        ${cell.mortgaged ? '<p style="color:var(--accent-danger);">🏦 该地产已抵押，无租金收入</p>' : ''}
        ${cell.type === 'city' && state.game.bank ? `<p style="font-size:12px;color:var(--text-tertiary);">🏦 银行房源：🏠 ×${state.game.bank.houses} ｜ 🏨 ×${state.game.bank.hotels}</p>` : ''}
        ${isBuyPrompt ? '<p style="color:var(--accent-success);">✅ 你在此格，可以购买</p>' : ''}
      </div>
    `,
    `
      ${isBuyPrompt ? `<button class="btn btn-sm btn-primary" onclick="hideModal();socket.emit('buy')">💰 购买 ¥${cell.price.toLocaleString()}</button>` : ''}
      ${actions}
      <button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>
    `,
    // 购地确认必须显式应答（购买或关闭按钮），ESC / 遮罩不关
    !isBuyPrompt
  );
}

window.manageProperty = function(action) {
  const cellId = state.selectedProp;
  if (cellId === null || cellId === undefined) return;
  hideModal();
  switch (action) {
    case 'build': socket.emit('build', { cellId, action: 'build' }); break;
    case 'sell': socket.emit('build', { cellId, action: 'sell' }); break;
    case 'mortgage': socket.emit('mortgage', { cellId }); break;      // FIX: was swapped
    case 'unmortgage': socket.emit('unmortgage', { cellId }); break;  // FIX: was swapped
  }
};

function toggleBuildMode() {
  if (!state.game) return;
  const me = state.game.players[state.myToken];
  if (!me) return;
  const buildable = (me.properties || []).filter(id => canBuildHere(id));
  if (!buildable.length) { toast('没有可建造的地产（需集齐同色系且均匀升级）', 'info'); return; }
  let html = '<div style="display:flex;flex-direction:column;gap:6px;">';
  buildable.forEach(id => {
    const c = state.game.board[id];
    const meta = GROUP_META[c.group];
    const cost = meta ? Math.floor(meta.houseCost * ((state.game && state.game.houseMul) || 1)) : 0;
    const now = c.level >= 5 ? '🏨' : (c.level ? '🏠'.repeat(c.level) : '空地');
    const next = c.level >= 4 ? '🏨酒店' : '🏠'.repeat(c.level + 1);
    const afford = me.money >= cost;
    html += `<button class="btn btn-sm ${afford ? 'btn-primary' : 'btn-secondary'}" onclick="hideModal();socket.emit('build',{cellId:${id},action:'build'})" ${afford ? '' : 'disabled'}>🏘 ${escapeHtml(c.name)}（${now} → ${next} · ¥${cost.toLocaleString()}）</button>`;
  });
  html += '</div>';
  showModal('🏗 选择要建造的地产', html, `<button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>`);
}

function toggleMortgageMode() {
  if (!state.game) return;
  const me = state.game.players[state.myToken];
  if (!me) return;
  const mortgagable = (me.properties || []).filter(id => {
    const c = state.game.board[id];
    return c && !c.mortgaged && (c.type !== 'city' || c.level === 0);
  });
  const redeemable = (me.properties || []).filter(id => {
    const c = state.game.board[id];
    return c && c.mortgaged;
  });
  if (!mortgagable.length && !redeemable.length) {
    toast('没有可抵押或可赎回的地产', 'info');
    return;
  }
  let html = '';
  if (mortgagable.length) {
    html += '<p style="font-weight:700;margin-bottom:6px;">🏦 抵押（获得 50% 地价）：</p><div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">';
    mortgagable.forEach(id => {
      const c = state.game.board[id];
      html += `<button class="btn btn-sm btn-secondary" onclick="hideModal();socket.emit('mortgage',{cellId:${id}})">🏘 ${escapeHtml(c.name)}（+¥${Math.floor(c.price * 0.5).toLocaleString()}）</button>`;
    });
    html += '</div>';
  }
  if (redeemable.length) {
    html += '<p style="font-weight:700;margin-bottom:6px;">🔓 赎回（付 110% 抵押价，恢复租金）：</p><div style="display:flex;flex-direction:column;gap:6px;">';
    redeemable.forEach(id => {
      const c = state.game.board[id];
      const cost = Math.floor(c.price * 0.5 * 1.1);
      const afford = me.money >= cost;
      html += `<button class="btn btn-sm ${afford ? 'btn-primary' : 'btn-secondary'}" onclick="hideModal();socket.emit('unmortgage',{cellId:${id}})" ${afford ? '' : 'disabled'}>🏘 ${escapeHtml(c.name)}（-¥${cost.toLocaleString()}）</button>`;
    });
    html += '</div>';
  }
  showModal('🏦 抵押 / 赎回', html, `<button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>`);
}

// ────────────────────────────────────────────────────────────
// 地产总览（全局资产一览）
// ────────────────────────────────────────────────────────────
function openAssetsOverview() {
  const g = state.game;
  if (!g) return;
  const row = c => {
    const owner = c.owner ? g.players[c.owner] : null;
    const meta = GROUP_META[c.group];
    const lv = c.type === 'city' ? (c.level >= 5 ? '🏨' : (c.level ? '🏠'.repeat(c.level) : '')) : '';
    const rent = c.rent > 0 ? `¥${c.rent.toLocaleString()}` : (c.rent === -1 ? '骰×40' : '—');
    return `<tr>
      <td><span class="ov-chip" style="background:${meta ? meta.color : '#888'}"></span>${escapeHtml(c.name)}</td>
      <td>${c.price ? '¥' + c.price.toLocaleString() : '—'}</td>
      <td>${owner ? `${owner.avatar} ${escapeHtml(owner.name)}${c.owner === state.myToken ? '<b style="color:var(--accent-primary);">(我)</b>' : ''}` : '<span style="color:var(--text-tertiary);">无主</span>'}${c.mortgaged ? ' 🏦' : ''}</td>
      <td>${lv || '—'}</td>
      <td>${rent}</td>
    </tr>`;
  };
  const groupOrder = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue'];
  const groupNames = { brown: '棕色', lightblue: '浅蓝', pink: '粉色', orange: '橙色', red: '红色', yellow: '黄色', green: '绿色', darkblue: '深蓝' };
  let body = '';
  groupOrder.forEach(gr => {
    const cells = g.board.filter(c => c.group === gr && c.type === 'city');
    if (!cells.length) return;
    body += `<tr class="ov-group"><td colspan="5">${groupNames[gr]}系（${GROUP_META[gr] ? GROUP_META[gr].name : ''}）</td></tr>`;
    body += cells.map(row).join('');
  });
  body += `<tr class="ov-group"><td colspan="5">🚂 铁路 / 💡 公用事业</td></tr>`;
  body += g.board.filter(c => c.type === 'railroad' || c.type === 'utility').map(row).join('');

  showModal(
    '📋 地产总览',
    `<div style="max-height:60vh;overflow-y:auto;">
      <table class="stats-table">
        <thead><tr><th>地产</th><th>价格</th><th>所有者</th><th>建筑</th><th>当前租金</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
     </div>
     <p style="font-size:11px;color:var(--text-tertiary);margin-top:8px;">🏦 = 已抵押（无租金收入）· 点击玩家可查看其资产详情</p>`,
    `<button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>`
  );
}

// ────────────────────────────────────────────────────────────
// RENDER: PLAYERS
// ────────────────────────────────────────────────────────────
function groupChipsHtml(p) {
  if (!state.game || !p.properties || !p.properties.length) return '';
  const groups = {};
  p.properties.forEach(id => {
    const c = state.game.board[id];
    if (c && c.type === 'city' && c.group) groups[c.group] = (groups[c.group] || 0) + 1;
  });
  const chips = Object.entries(groups).map(([g, n]) => {
    const total = state.game.board.filter(c => c.type === 'city' && c.group === g).length;
    const meta = GROUP_META[g];
    if (!meta || total === 0) return '';
    const cls = n === total ? ' full' : (n === total - 1 ? ' near' : '');
    return `<span class="gchip${cls}" style="background:${meta.color};color:${textOn(meta.color)};" title="${meta.name}${n === total ? '：已集齐！' : n === total - 1 ? '：差 1 块集齐！' : ''}">${meta.name} ${n}/${total}</span>`;
  }).filter(Boolean);
  if (!chips.length) return '';
  return `<div class="group-chips">${chips.join('')}</div>`;
}

function statusLine(p, isMe) {
  if (p.bankrupt) return '💀 破产';
  if (p.isBot && p.origName) return `🤖 代打中（原${escapeHtml(p.origName)}，重进可收回）`;
  if (p.isBot) return '🤖 机器人';
  if (!p.connected) return p.delegated ? '💤 掉线·AI托管中' : '💤 掉线';
  if (p.delegated) return '🕹 托管中';
  const base = p.jailTurns > 0 ? `🔒 监狱 ${p.jailTurns}回合` : `📍 第${p.pos}格`;
  return base + (isMe ? '' : '');
}

function renderPlayers() {
  if (!state.game) return;
  const rg = displayGame();
  const ordered = [...rg.order].sort((a, b) => {
    const pa = rg.players[a], pb = rg.players[b];
    return (pa && pa.bankrupt ? 1 : 0) - (pb && pb.bankrupt ? 1 : 0);
  });

  const seen = new Set(ordered);
  // 移除已离开/破产被剔除的玩家卡片
  Object.keys(playerCards).forEach(pid => {
    if (!seen.has(pid)) {
      const c = playerCards[pid];
      if (c && c.div && c.div.parentNode) c.div.parentNode.removeChild(c.div);
      delete playerCards[pid];
    }
  });

  // 按 sorted 顺序追加（已存在的节点 appendChild = 移动；新建 = 创建）
  // 仅当顺序真的变化时才移动，避免无谓 reflow
  const orderSig = ordered.join(',');
  const needReorder = orderSig !== playerOrderSig;
  ordered.forEach(pid => {
    const p = rg.players[pid];
    if (!p) return;
    const isCurrentTurn = rg.order[rg.turnIndex] === pid && rg.started && !rg.ended;
    const isMe = pid === state.myToken;
    const isHost = pid === state.game.hostToken;
    const teamChip = p.team ? `<span class="solid-chip" style="background:${p.team === 'A' ? 'var(--player-0)' : 'var(--player-1)'};margin-left:4px;">${p.team}</span>` : '';
    const chipsHtml = groupChipsHtml(p);

    // 内容签名：任一字段变化才更新内部 HTML，否则原样复用
    const sig = [
      isCurrentTurn ? '1' : '0', p.bankrupt ? '1' : '0',
      p.name, p.avatar, p.isBot ? '1' : '0', p.botLevel || '',
      isMe ? '1' : '0', isHost ? '1' : '0', p.team || '',
      p.money, p.jailFreeCards || 0, p.jailTurns || 0,
      p.delegated ? '1' : '0', p.connected ? '1' : '0', p.origName || '',
      p.properties ? p.properties.length : 0,
      chipsHtml,
    ].join('|');

    let card = playerCards[pid];
    if (!card) {
      const div = document.createElement('div');
      div.className = 'player-item';
      div.style.cursor = 'pointer';
      div.title = '点击查看资产总览';
      // listener 只挂一次，节点复用期间不重复绑定
      div.setAttribute('role', 'button');
      makeKeyboardActivatable(div, () => openPlayerModal(pid));
      div.addEventListener('click', () => openPlayerModal(pid));

      const dot = document.createElement('div');
      dot.className = 'player-dot';
      const info = document.createElement('div');
      info.className = 'player-info';
      const money = document.createElement('div');
      money.className = 'player-money';

      div.appendChild(dot);
      div.appendChild(info);
      div.appendChild(money);

      card = { div, dot, info, money, sig: null };
      playerCards[pid] = card;
      els.playersList.appendChild(div);
    } else if (needReorder) {
      els.playersList.appendChild(card.div); // 移动到末尾（按序）
    }

    // 增量更新：签名变化才重写 innerHTML / 文本 / class
    if (card.sig !== sig) {
      card.div.className = `player-item ${isCurrentTurn ? 'active' : ''} ${p.bankrupt ? 'bankrupt' : ''}`;
      card.dot.style.background = playerColor(pid);
      card.dot.style.color = playerColor(pid);
      card.dot.innerHTML = `<span style="font-size:10px;">${p.avatar}</span>`;
      card.info.innerHTML = `
        <div class="player-name" style="color:${playerColor(pid)}">${teamChip}
          ${escapeHtml(p.name)}${p.isBot ? ` <span class="bot-tag">BOT${p.botLevel === 'easy' ? '🙂' : p.botLevel === 'hard' ? '😈' : ''}</span>` : ''}
          ${isMe ? ' <span style="color:var(--player-1)">(我)</span>' : ''}${isHost ? ' 👑' : ''}
        </div>
        <div class="player-status">
          ${statusLine(p, isMe)}
          ${p.jailFreeCards > 0 ? ` | 🎴×${p.jailFreeCards}` : ''}
        </div>
        ${chipsHtml}
      `;
      card.money.className = 'player-money ' + (p.money > 30000 ? 'tone-good' : p.money > 0 ? 'tone-warn' : 'tone-bad');
      card.money.textContent = formatMoney(p.money);
      // 无障碍：玩家卡片是 div，补可读名称 + 当前回合成焦点指示
      card.div.setAttribute('aria-label', `${p.name}${p.isBot ? '（机器人）' : ''}${isMe ? '（我）' : ''}，`
        + `${statusLine(p, isMe)}，现金 ${formatMoney(p.money)}，地产 ${p.properties ? p.properties.length : 0} 块，查看资产总览`);
      if (isCurrentTurn) card.div.setAttribute('aria-current', 'true');
      else card.div.removeAttribute('aria-current');
      card.sig = sig;
    }
  });
  playerOrderSig = orderSig;
}

// ────────────────────────────────────────────────────────────
// RENDER: CONTROLS
// ────────────────────────────────────────────────────────────
function renderControls() {
  if (!state.game) return;
  const me = state.game.players?.[state.myToken];
  const myTurn = isMyTurn();
  const alive = !!me && !me.bankrupt;
  const inGame = state.game.started && !state.game.ended;
  const isHost = state.game.hostToken === state.myToken;
  const inJail = !!(me && me.jailTurns > 0);

  // ── 按阶段显示/隐藏按钮，避免一堆灰按钮让人不知所措 ──
  const show = (el, on, disabled = false) => {
    if (!el) return;
    el.style.display = on ? '' : 'none';
    el.disabled = !on || disabled;
  };
  const idlePhase = !state.game.started && !state.game.ended;

  show(els.startBtn, idlePhase && isHost, state.game.order.length < 2);
  show(els.botBtn, idlePhase && isHost);
  show(els.roundLimitRow, idlePhase && isHost);
  if (idlePhase && isHost && String(state.game.maxRounds || 0) !== els.maxRoundsSel.value) {
    els.maxRoundsSel.value = String(state.game.maxRounds || 0);
  }
  show(els.roomSettingsRow, idlePhase && isHost);
  show(els.roomSetupCard, idlePhase && isHost);
  if (idlePhase && isHost && state.game.settings) {
    const st = state.game.settings;
    if (String(st.startMoney) !== els.startMoneySel.value) els.startMoneySel.value = String(st.startMoney);
    if (els.jackpotChk.checked !== !!st.jackpotOn) els.jackpotChk.checked = !!st.jackpotOn;
    if (els.auctionChk.checked !== !!st.auctionOn) els.auctionChk.checked = !!st.auctionOn;
    if (state.game.mapId && els.mapSel.value !== state.game.mapId) els.mapSel.value = state.game.mapId;
    if (String(st.turnTimeoutMs || 120000) !== els.turnTimeSel.value) els.turnTimeSel.value = String(st.turnTimeoutMs || 120000);
    if (els.teamModeChk.checked !== !!st.teamMode) els.teamModeChk.checked = !!st.teamMode;
    if (String(st.botSpeed || 1) !== els.botSpeedSel.value) els.botSpeedSel.value = String(st.botSpeed || 1);
  }
  // 未开局时隐藏一切对局按钮
  // 托管按钮：游戏中且自己存活可用（真人席位）
  const delegatable = inGame && alive && !me.isBot;
  show(els.delegateBtn, delegatable);
  if (delegatable) {
    els.delegateBtn.textContent = me.delegated ? '🕹 取消托管（恢复手动）' : '🕹 托管（AI 代打）';
    els.delegateBtn.classList.toggle('btn-delegating', !!me.delegated);
  }
  // 托管中：AI 全权操作，隐藏手动对局按钮
  const manual = inGame && alive && !me.delegated;
  show(els.rollBtn, manual);
  show(els.buyBtn, manual && myTurn && canBuyNow());
  show(els.bailBtn, manual && myTurn && inJail && me.money >= 1000);
  show(els.endTurnBtn, manual);
  show(els.buildBtn, manual);
  show(els.mortgageBtn, manual);
  els.rollBtn.innerHTML = `<span class="btn-emoji">🎲</span><span>${inJail && myTurn ? '试掷双数出狱' : '掷骰子'}</span>`;
  const rolled = !!state.game.currentRolled;
  const inDebt = !!(state.game.debt && state.game.debt.playerId === state.myToken);
  els.rollBtn.disabled = !(manual && myTurn && !state.game.diceAnim && !rolled && !inDebt);
  els.endTurnBtn.disabled = !(manual && myTurn && !state.game.diceAnim && rolled && !inDebt);
  els.buildBtn.disabled = !(manual && !state.game.diceAnim);
  els.mortgageBtn.disabled = !(manual && !state.game.diceAnim);
  els.tradeBtn.disabled = delegatable && !me.delegated && !state.game.diceAnim;

  // ── 提示：告诉玩家"现在该做什么" ──
  let hint = '';
  if (state.game.ended) {
    // 优先用服务端判定的胜者（回合上限=净资产最高；淘汰制=最后存活）
    const winner = state.game.winnerToken || state.game.order.find(id => !state.game.players[id].bankrupt);
    hint = `🎉 游戏结束！${winner ? state.game.players[winner].name + ' 获胜' : '平局'}。点「开始新局」再来一局。`;
    if (!state.victoryShown) {
      state.victoryShown = true;
      showVictoryStats(winner);
      confettiBurst();
    }
  } else if (idlePhase) {
    hint = isHost
      ? (state.game.order.length < 2
        ? '👇 你一个人也能玩：点下方「🤖 添加机器人」，再点「▶ 开始游戏」'
        : '人齐了，点「▶ 开始游戏」开局')
      : '已进入房间，等待房主开始游戏…';
  } else if (!me) {
    hint = '👀 观战中：游戏进行中，下一局可参与。';
  } else if (me.isBot && me.origName) {
    hint = '🤖 你的席位正由机器人代打。进入同一房间即可收回控制权。';
  } else if (me.delegated) {
    hint = '🕹 托管中：AI 正替你掷骰、买地、盖房。点「取消托管」随时恢复手动。';
  } else if (me.bankrupt) {
    hint = '💀 你已破产，观战到本局结束。';
  } else if (state.game.debt) {
    const d = state.game.debt;
    const debtor = state.game.players[d.playerId];
    const left = Math.max(0, Math.ceil((d.deadline - Date.now()) / 1000));
    if (d.playerId === state.myToken) {
      hint = `💀 你欠款 ¥${d.amount.toLocaleString()}，剩 ${left} 秒：点自己的地产「🏦 抵押」或「出售建筑」筹钱，否则破产！`;
    } else {
      hint = `⚠️ ${debtor ? debtor.name : '?'} 欠款 ¥${d.amount.toLocaleString()}，筹钱中（剩 ${left} 秒）…`;
    }
  } else if (state.game.diceAnim) {
    hint = '🎲 骰子滚动中…';
  } else if (!myTurn) {
    const cur = state.game.players[state.game.order[state.game.turnIndex]];
    hint = `⏳ 等待 ${cur ? cur.avatar + ' ' + cur.name : '…'} 行动。趁现在可以点自己的地产盖房/抵押。`;
  } else if (inJail) {
    hint = `🔒 你在监狱（还剩 ${me.jailTurns} 回合）：掷出双数免费出狱，或点「保释」花 ¥1000 立刻出狱。`;
  } else if (state.game.currentRolled) {
    const cell = state.game.board[me.pos];
    const buyable = !cell.owner && cell.price > 0 && me.money >= cell.price &&
      ['city', 'railroad', 'utility'].includes(cell.type);
    hint = buyable
      ? `📍 你停在「${cell.name}」（无主）：「💰 购买」或「⏭ 结束回合」（放弃将进入拍卖）`
      : `📍 停在「${cell.name}」，点「⏭ 结束回合」交给下家。`;
  } else {
    const cell = state.game.board[me.pos];
    const buyable = !cell.owner && cell.price > 0 && me.money >= cell.price &&
      ['city', 'railroad', 'utility'].includes(cell.type);
    hint = buyable
      ? `📍 你停在「${cell.name}」（无主）：点「💰 购买」买下它，或直接掷骰子放弃。`
      : '📍 点绿色「🎲 掷骰子」前进。';
  }

  // 仅在文本真变化时写入：aria-live 区域避免每次广播都重复播报
  if (els.actionHint.textContent !== hint) els.actionHint.textContent = hint;
  updateQuickStats();
  updateTurnTimer();
}

// 结算统计面板：按净资产排名
function confettiBurst() {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  const colors = ['#ff6b6b', '#4fc3f7', '#69f0ae', '#ffb74d', '#ce93d8', '#f06292', '#ffd54f'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 1.2) + 's';
    p.style.animationDuration = (2.5 + Math.random() * 2) + 's';
    const size = 6 + Math.random() * 7;
    p.style.width = size + 'px';
    p.style.height = size * 0.6 + 'px';
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 5200);
}

function showVictoryStats(winnerToken) {
  const g = state.game;
  const rows = g.order.map(pid => {
    const p = g.players[pid];
    const propVal = (p.properties || []).reduce((s, id) => s + (g.board[id]?.price || 0), 0);
    const houses = (p.properties || []).reduce((s, id) => s + (g.board[id]?.level || 0), 0);
    return { p, propVal, houses, net: p.money + propVal };
  }).sort((a, b) => (b.p.bankrupt ? 0 : 1) - (a.p.bankrupt ? 0 : 1) || b.net - a.net);

  const winnerName = winnerToken ? g.players[winnerToken].name : '无（平局）';
  // 本局之最
  const builderRows = rows.map(r => ({
    ...r,
    lv: (r.p.properties || []).reduce((s, id) => s + (g.board[id]?.level || 0), 0),
  }));
  const awards = [
    { icon: '💰', label: '首富', who: rows[0] && rows[0].p },
    { icon: '🏘', label: '地产大亨', who: [...rows].sort((a, b) => b.p.properties.length - a.p.properties.length)[0]?.p },
    { icon: '🏗', label: '建筑王', who: builderRows.sort((a, b) => b.lv - a.lv)[0]?.p },
    { icon: '🏦', label: '包租公', who: [...rows].sort((a, b) => (b.p.rentEarned || 0) - (a.p.rentEarned || 0))[0]?.p },
  ].filter(a => a.who && (a.label !== '包租公' || (a.who.rentEarned || 0) > 0));
  const awardsHtml = awards.map(a =>
    `<span class="award-chip">${a.icon} ${a.label}：${escapeHtml(a.who.name)}${a.who.id === state.myToken ? '（你）' : ''}</span>`
  ).join('');
  const mr = state.game.maxRent;
  const elapsedHtml = state.game.startedAt ? `<p style="text-align:center;font-size:12px;color:var(--text-tertiary);margin-bottom:10px;">⏱ 本局用时 ${fmtElapsed(state.game.startedAt)} · 共 ${state.game.roundCount || 1} 轮</p>` : '';
  const maxRentHtml = mr ? `<p style="text-align:center;font-size:13px;color:var(--text-secondary);margin-bottom:10px;">💸 本局最大单笔租金：<b style="color:var(--accent-warning);">¥${mr.amount.toLocaleString()}</b>（${escapeHtml(mr.from)} → ${escapeHtml(mr.to)} 的「${escapeHtml(mr.cell)}」）</p>` : '';
  const dh = state.game.diceHistory || [];
  const dhMax = Math.max(1, ...dh);
  const diceHtml = dh.some(v => v > 0) ? `<p style="text-align:center;font-size:12px;color:var(--text-secondary);margin-bottom:10px;">🎲 掷骰分布：<br>${dh.slice(2).map((v, i) =>
    `<span style="display:inline-block;margin:2px 4px;">${i + 2}点 <b style="color:var(--accent-warning);">${'▉'.repeat(Math.max(1, Math.round(v / dhMax * 8)))}</b> ${v}</span>`).join('<br>')}</p>` : '';
  const hot = Object.entries(state.game.landingStats || {})
    .map(([id, n]) => ({ name: state.game.board[id] ? state.game.board[id].name : '?', n }))
    .sort((a, b) => b.n - a.n).slice(0, 3);
  const hotHtml = hot.length ? `<p style="text-align:center;font-size:13px;color:var(--text-secondary);margin-bottom:10px;">🔥 最繁忙地段：${hot.map(h => `${escapeHtml(h.name)}（${h.n}次）`).join('、')}</p>` : '';
  const rich = state.game.board
    .filter(c => (c.incomeEarned || 0) > 0)
    .sort((a, b) => (b.incomeEarned || 0) - (a.incomeEarned || 0))
    .slice(0, 3);
  const richHtml = rich.length ? `<p style="text-align:center;font-size:13px;color:var(--text-secondary);margin-bottom:10px;">💰 最赚钱街区：${rich.map(c => `${escapeHtml(c.name)}（¥${(c.incomeEarned || 0).toLocaleString()}）`).join('、')}</p>` : '';
  const tableRows = rows.map((r, i) => `
    <tr class="${!r.p.bankrupt ? 'winner' : ''}">
      <td>${i + 1}</td>
      <td>${r.p.avatar} ${escapeHtml(r.p.name)}${r.p.isBot ? ' <span class="bot-tag">BOT</span>' : ''}${r.p.id === state.myToken ? ' (我)' : ''}</td>
      <td>${r.p.bankrupt ? '💀 破产' : formatMoney(r.p.money)}</td>
      <td>${r.p.bankrupt ? '—' : '¥' + r.propVal.toLocaleString()}</td>
      <td>${r.p.bankrupt ? '—' : r.houses}</td>
      <td>${r.p.bankrupt ? '—' : '<b>' + formatMoney(r.net) + '</b>'}</td>
    </tr>
  `).join('');

  showModal(
    '🏆 游戏结束',
    `
      <p style="font-size:17px;text-align:center;padding:6px 0 12px;">🏆 胜者：<strong style="color:var(--accent-warning);">${escapeHtml(winnerName)}</strong></p>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:12px;">${awardsHtml}</div>
      ${elapsedHtml}
      ${maxRentHtml}
      ${diceHtml}
      ${richHtml}
      ${hotHtml}
      ${(state.game.nwHistory || []).length >= 2 ? '<div style="display:flex;justify-content:center;margin-bottom:10px;"><canvas id="nwCanvas"></canvas></div>' : ''}
      <table class="stats-table">
        <thead><tr><th>#</th><th>玩家</th><th>现金</th><th>地产</th><th>建筑</th><th>净资产</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `,
    `<button class="btn btn-secondary" onclick="openReplay()">🎥 回放本局</button>
     <button class="btn btn-secondary" onclick="exportGameLog()">💾 导出对局记录</button>
     <button class="btn btn-primary" onclick="hideModal();socket.emit('reset')">🔄 开始新局</button>`
  );
  requestAnimationFrame(() => drawNwChart(document.getElementById('nwCanvas'), state.game ? (state.game.nwHistory || []) : []));
}

// 回合倒计时（服务器 turnStartedAt + turnTimeoutMs）
function updateTurnTimer() {
  if (!els.turnTimer || !state.game) return;
  const g = state.game;
  // 欠款倒计时优先
  if (g.debt) {
    const left = Math.max(0, Math.ceil((g.debt.deadline - Date.now()) / 1000));
    const debtor = g.players[g.debt.playerId];
    els.turnTimer.textContent = `💀 ${debtor ? debtor.name : '?'} 欠款 ¥${g.debt.amount.toLocaleString()} · 剩 ${left}s 筹钱`;
    els.turnTimer.style.color = 'var(--accent-danger)';
    return;
  }
  if (!g.started || g.ended || !g.turnStartedAt || !g.turnTimeoutMs) {
    els.turnTimer.textContent = '';
    els.turnTimer.style.color = '';
    return;
  }
  const cur = g.players[g.order[g.turnIndex]];
  if (!cur || cur.isBot || cur.bankrupt || !cur.connected) { els.turnTimer.textContent = ''; return; }
  const left = Math.max(0, g.turnTimeoutMs - (Date.now() - g.turnStartedAt));
  if (left <= 0) { els.turnTimer.textContent = ''; return; }
  const s = Math.ceil(left / 1000);
  els.turnTimer.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 后自动结束回合`;
  els.turnTimer.style.color = left < 30000 ? 'var(--accent-danger)' : '';
}

function canBuyNow() {
  const g = state.game;
  const me = g.players?.[state.myToken];
  if (!me || me.pos === undefined) return false;
  const cell = g.board[me.pos];
  return cell && !cell.owner && me.money >= cell.price &&
    (cell.type === 'city' || cell.type === 'railroad' || cell.type === 'utility');
}

function updateQuickStats() {
  if (!state.game) return;
  const me = state.game.players?.[state.myToken];
  if (!me) { els.quickStats.innerHTML = '<div class="stat">观战模式</div>'; return; }
  const propCount = me.properties?.length || 0;
  const netWorth = me.money + (me.properties?.reduce((sum, id) => sum + (state.game.board[id]?.price || 0), 0) || 0);
  els.quickStats.innerHTML = `
    <div class="stat">地产: <strong>${propCount}块</strong></div>
    <div class="stat">净资产: <strong>${formatMoney(netWorth)}</strong></div>
    <div class="stat">出狱卡: <strong>${me.jailFreeCards || 0}张</strong></div>
  `;
}

// ────────────────────────────────────────────────────────────
// LOG & CHAT
// ────────────────────────────────────────────────────────────
function renderLog() {
  if (!state.game) return;

  const combined = [];
  // 回放模式：只显示该帧之前的历史日志（并隐藏实时聊天）
  if (state.replayIdx !== null && state.game.replay && state.game.replay.length) {
    const snap = state.game.replay[Math.min(state.replayIdx, state.game.replay.length - 1)];
    state.game.logs.slice(0, snap ? snap.lg : undefined).forEach(l => combined.push({ ...l, type: 'game' }));
  } else {
    state.game.chats.forEach(c => combined.push({ ...c, type: c.from === '系统' ? 'system' : 'chat' }));
    state.game.logs.forEach(l => combined.push({ ...l, type: 'game' }));
  }
  combined.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  let filtered = state.logFilter === 'all' ? combined : combined.filter(e => e.type === state.logFilter);
  if (state.replayIdx !== null) filtered = filtered.filter(e => e.type === 'game');

  const shown = filtered.slice(-60).reverse();

  // 渲染签名：条目内容/类型/时间戳任一变化才重建，避免频繁广播时空跑 DOM
  const sig = shown.map(i => `${i.type}::${i.ts || 0}::${i.from || ''}::${i.text || ''}`).join('##');
  if (sig === lastLogSig) return; // 内容未变 → 复用现有 DOM（含动画/滚动状态）
  lastLogSig = sig;

  els.log.innerHTML = '';
  shown.forEach(item => {
    const p = document.createElement('p');
    p.className = `log-entry ${item.type}`;
    const timeStr = new Date(item.ts || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (item.type === 'game') {
      p.innerHTML = `<span class="log-time">${timeStr}</span>${escapeHtml(item.text || '')}`;
    } else {
      p.innerHTML = `<span class="log-time">${timeStr}</span><span class="log-from">${escapeHtml(item.from)}:</span> ${escapeHtml(item.text || '')}`;
    }
    els.log.appendChild(p);
  });
  els.log.scrollTop = 0;
}

// ────────────────────────────────────────────────────────────
// DICE ANIMATION (guarded, no interval leak)
// ────────────────────────────────────────────────────────────
function animateDice() {
  if (!state.game) return;
  if (state.game.diceAnim) {
    if (state.diceTimer) return; // already animating
    els.diceOverlay.classList.remove('hidden');
    els.diceResult.textContent = '';
    const faces = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    let counter = 0;
    state.diceTimer = setInterval(() => {
      els.die1.textContent = faces[Math.floor(Math.random() * 6)];
      els.die2.textContent = faces[Math.floor(Math.random() * 6)];
      if (++counter > 8) {
        clearInterval(state.diceTimer);
        state.diceTimer = null;
        const d = state.game.dice || [1, 1];
        els.die1.textContent = faces[d[0] - 1];
        els.die2.textContent = faces[d[1] - 1];
        const isDouble = d[0] === d[1];
        els.diceResult.textContent = `${d[0]} + ${d[1]} = ${d[0] + d[1]}${isDouble ? ' 🎯 双数!' : ''}`;
        setTimeout(() => els.diceOverlay.classList.add('hidden'), 700);
      }
    }, 90);
  } else if (state.diceTimer) {
    clearInterval(state.diceTimer);
    state.diceTimer = null;
    els.diceOverlay.classList.add('hidden');
  }
}

function updateTurnBanner() {
  if (!state.game || !state.game.started || state.game.ended) {
    els.turnBanner.classList.add('hidden');
    return;
  }
  const cur = state.game.players?.[state.game.order?.[state.game.turnIndex]];
  if (!cur) { els.turnBanner.classList.add('hidden'); return; }

  els.turnAvatar.textContent = cur.avatar || cur.name.charAt(0);
  els.turnAvatar.style.background = playerColor(cur.id);
  els.turnText.textContent = `${cur.name} 的回合${cur.isBot ? ' (机器人)' : ''}`;
  els.turnBanner.classList.remove('hidden');
}

// ────────────────────────────────────────────────────────────
// BOT MODAL
// ────────────────────────────────────────────────────────────
function openBotModal() {
  if (!state.game || state.game.started) return;
  const bots = state.game.order.filter(id => state.game.players[id]?.isBot);
  showModal(
    '🤖 管理机器人',
    `
      <p style="margin-bottom:10px;font-size:14px;">添加 AI 机器人陪你玩，机器人会自动掷骰子、买地、盖房。</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        <button class="btn btn-success" onclick="hideModal();socket.emit('addBot',{difficulty:'easy'})" ${bots.length >= 7 ? 'disabled' : ''}>🙂 简单</button>
        <button class="btn btn-primary" onclick="hideModal();socket.emit('addBot',{difficulty:'normal'})" ${bots.length >= 7 ? 'disabled' : ''}>😐 普通</button>
        <button class="btn btn-danger" onclick="hideModal();socket.emit('addBot',{difficulty:'hard'})" ${bots.length >= 7 ? 'disabled' : ''}>😈 困难</button>
      </div>
      ${bots.length > 0 ? `<div style="margin-bottom:14px;"><button class="btn btn-sm btn-secondary" onclick="hideModal();socket.emit('kickBot')">- 移除最后一个机器人</button></div>` : ''}
      ${bots.length > 0 ? `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">当前机器人：</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${bots.map(id => {
            const b = state.game.players[id];
            const face = b.botLevel === 'easy' ? '🙂' : b.botLevel === 'hard' ? '😈' : '😐';
            return `<span class="bot-chip">${b.avatar} ${escapeHtml(b.name)} ${face}<button class="bot-chip-x" aria-label="移除机器人 ${escapeHtml(b.name)}" title="移除该机器人" onclick="kickOneBot('${id}')">✕</button></span>`;
          }).join('')}
        </div>` : '<p style="font-size:13px;color:var(--text-tertiary);">还没有机器人。至少需要2名玩家才能开始游戏。</p>'}
    `,
    `<button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>`
  );
}

// ────────────────────────────────────────────────────────────
// TRADE MODAL
// ────────────────────────────────────────────────────────────
function openTradeModal() {
  if (!state.game) return;
  const others = Object.values(state.game.players).filter(p => {
    return p && !p.bankrupt && p.id !== state.myToken;
  });
  if (others.length === 0) { toast('没有可交易的玩家', 'info'); return; }

  let html = '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
  others.forEach(p => {
    const color = state.game.order.includes(p.id) ? playerColor(p.id) : '#7f8c8d';
    const tag = p.isBot ? ' <span class="bot-tag">BOT</span>' : '';
    html += `<button class="btn btn-sm btn-target" style="background:${color};" onclick="selectTradeTarget('${p.id}')">${p.avatar} ${escapeHtml(p.name)}${tag} ¥${p.money.toLocaleString()}</button>`;
  });
  html += '</div>';

  showModal('🤝 选择交易对象', html, `<button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>`);
}

window.selectTradeTarget = function(pid) {
  state.tradeTarget = pid;
  hideModal();
  const target = state.game.players[pid];
  const myProps = (state.game.players[state.myToken]?.properties || []);
  const tgProps = (target.properties || []);

  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px;">
      <div>
        <p style="font-weight:700;margin-bottom:6px;">你付出：</p>
        <label>现金 ¥ <input type="number" id="giveMoney" class="glass-input" value="0" min="0" max="${state.game.players[state.myToken].money}" style="width:90px;"></label>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto;">
          ${myProps.length === 0 ? '<span style="color:var(--text-tertiary);">无地产</span>' : myProps.map(id => {
            const c = state.game.board[id];
            const locked = c.level > 0;
            return `<label class="${locked ? 'prop-locked' : ''}"><input type="checkbox" class="giveProp" value="${id}" ${locked ? 'disabled' : ''}> ${escapeHtml(c.name)}${locked ? ' 🏠须先卖建筑' : ''}</label>`;
          }).join('')}
        </div>
      </div>
      <div>
        <p style="font-weight:700;margin-bottom:6px;">换回（对方：${escapeHtml(target.name)}）：</p>
        <label>现金 ¥ <input type="number" id="getMoney" class="glass-input" value="0" min="0" max="${target.money}" style="width:90px;"></label>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto;">
          ${tgProps.length === 0 ? '<span style="color:var(--text-tertiary);">对方无地产</span>' : tgProps.map(id => {
            const c = state.game.board[id];
            const locked = c.level > 0;
            return `<label class="${locked ? 'prop-locked' : ''}"><input type="checkbox" class="getProp" value="${id}" ${locked ? 'disabled' : ''}> ${escapeHtml(c.name)}${locked ? ' 🏠' : ''}</label>`;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  showModal(
    `🤝 与 ${escapeHtml(target.name)} 交易`,
    html,
    `
      <button class="btn btn-sm btn-primary" onclick="confirmTrade('${pid}')">确认交易</button>
      <button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>
    `,
    // 交易编辑弹窗：填了筹码后不能被 ESC / 点遮罩误关，只能走「确认 / 取消」
    false
  );
};

window.confirmTrade = function(pid) {
  const giveMoney = parseInt(document.getElementById('giveMoney')?.value || '0', 10);
  const getMoney = parseInt(document.getElementById('getMoney')?.value || '0', 10);
  const giveProps = [...document.querySelectorAll('.giveProp:checked')].map(el => parseInt(el.value, 10));
  const getProps = [...document.querySelectorAll('.getProp:checked')].map(el => parseInt(el.value, 10));
  hideModal();
  socket.emit('trade', { targetId: pid, giveMoney, giveProps, getMoney, getProps });
  toast('交易提议已发送，等待对方回应（30 秒）', 'info');
};

// ────────────────────────────────────────────────────────────
// SETTINGS & HELP
// ────────────────────────────────────────────────────────────
function openSettings() {
  showModal(
    '⚙️ 设置',
    `
      <div class="setting-item">
        <label for="nameInput">你的昵称</label>
        <input type="text" id="nameInput" class="glass-input" maxlength="16" value="${escapeHtml(localStorage.getItem('monopoly_name') || '')}"
          style="width:180px;"/>
      </div>
      <div class="setting-item">
        <label for="avatarInput">头像</label>
        <select id="avatarInput" class="glass-select">
          ${PLAYER_AVATARS.map(a => {
            const cur = state.game?.players?.[state.myToken]?.avatar || localStorage.getItem('monopoly_avatar');
            return `<option value="${a}" ${cur === a ? 'selected' : ''}>${a}</option>`;
          }).join('')}
        </select>
      </div>
      ${(!state.game || (state.game.hostToken === state.myToken && !state.game.started)) ? `
      <div class="setting-item">
        <label for="roomPwdInput">🔒 房间密码（4~12位字母数字，留空保存=取消密码）</label>
        <input type="text" id="roomPwdInput" class="glass-input" maxlength="12" placeholder="${(state.game && state.game.password) ? '已设置' : '未设置'}"
          style="width:130px;"/>
      </div>` : ''}
      <div class="setting-item">
        <label for="themeInput">🎨 界面主题</label>
        <span style="display:flex;align-items:center;gap:8px;">
          <select id="themeInput" class="glass-select" onchange="Theme.set(this.value)">
            <option value="dark" ${Theme.get() === 'dark' ? 'selected' : ''}>🌙 深色玻璃</option>
            <option value="light" ${Theme.get() === 'light' ? 'selected' : ''}>☀️ 浅色玻璃</option>
          </select>
          <select id="glassInput" class="glass-select" aria-label="毛玻璃强度" title="低端设备或文字发虚时可降低模糊强度" onchange="Theme.setGlass(this.value)">
            <option value="full" ${Theme.glass() === 'full' ? 'selected' : ''}>毛玻璃：完整</option>
            <option value="soft" ${Theme.glass() === 'soft' ? 'selected' : ''}>毛玻璃：柔和</option>
            <option value="off" ${Theme.glass() === 'off' ? 'selected' : ''}>毛玻璃：关闭</option>
          </select>
        </span>
      </div>
      <div class="setting-item">
        <label for="soundInput">音效</label>
        <span style="display:flex;align-items:center;gap:8px;">
          <label class="toggle"><input type="checkbox" id="soundInput" ${Sound.enabled ? 'checked' : ''}><span class="slider"></span></label>
          <input type="range" id="volumeInput" min="0" max="100" value="${Sound.volume}" aria-label="音量" style="width:100px;" title="音量">
          <span style="font-size:11px;color:var(--text-tertiary);">${Sound.volume}%</span>
        </span>
      </div>
      <div class="setting-item">
        <label for="autoBuyInput">自动购买（落地即买下可负担的无主地产）</label>
        <label class="toggle"><input type="checkbox" id="autoBuyInput" ${(state.game && state.game.players[state.myToken] && state.game.players[state.myToken].autoBuy) ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <p style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">昵称/头像在下一局开始时生效；如需换房间请返回大厅。</p>
    `,
    `
      <button class="btn btn-sm btn-primary" onclick="saveSettings()">保存</button>
      <button class="btn btn-sm btn-ghost" onclick="hideModal()">取消</button>
    `
  );
}

window.saveSettings = function() {
  const name = document.getElementById('nameInput')?.value?.trim();
  const avatar = document.getElementById('avatarInput')?.value;
  const themeSel = document.getElementById('themeInput')?.value;
  const glassSel = document.getElementById('glassInput')?.value;
  if (themeSel) Theme.set(themeSel);
  if (glassSel) Theme.setGlass(glassSel);
  const soundOn = document.getElementById('soundInput')?.checked;
  const volumeVal = document.getElementById('volumeInput')?.value;
  const autoBuyOn = document.getElementById('autoBuyInput')?.checked;
  if (name) localStorage.setItem('monopoly_name', name.slice(0, 16));
  if (avatar) localStorage.setItem('monopoly_avatar', avatar);
  if (typeof soundOn === 'boolean') {
    Sound.enabled = soundOn;
    localStorage.setItem('monopoly_sound', soundOn ? 'on' : 'off');
  }
  if (volumeVal !== undefined && volumeVal !== null) {
    Sound.volume = Number(volumeVal);
    localStorage.setItem('monopoly_volume', String(Sound.volume));
    Sound.play([[523, 0.08, 0]]);
  }
  if (typeof autoBuyOn === 'boolean') socket.emit('setAutoBuy', { on: autoBuyOn });
  const roomPwd = document.getElementById('roomPwdInput');
  if (roomPwd && roomPwd.value.trim() !== '') socket.emit('setSettings', { password: roomPwd.value.trim() });
  if (roomPwd) roomPwd.value = '';
  if (els.lobbyName) els.lobbyName.value = name || '';
  state.selectedAvatar = avatar || state.selectedAvatar;
  renderAvatarGrid();
  hideModal();
  toast('设置已保存', 'success');
};

function openHelp() {
  showModal(
    '❓ 游戏帮助',
    `
      <div style="font-size:13px; line-height:1.7;">
        <p><strong>🎮 操作说明</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li><b>空格</b> / 点"掷骰子"：掷骰移动（双数再走一次，3次双数入狱）</li>
          <li><b>B</b> / 点"购买"：买下脚下的无主地产</li>
          <li>点击<b>任意格子</b>查看详情与完整租金表；点击己方地产可 <b>建造/出售/抵押/赎回</b>（随时可操作，不限自己回合）</li>
          <li>集齐同色系全部地产才能建造，且需等差均匀升级；空地集齐全组时基础租金 ×2</li>
          <li><b>T</b>：与其他真人玩家交易地产/现金</li>
          <li><b>E</b> / 点"结束回合"：交给下一位</li>
        </ul>
        <p><strong>🔒 监狱规则</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>入狱后每回合可<b>试掷双数</b>：掷出即出狱并移动</li>
          <li>或随时支付 <b>¥1000 保释</b>（按 P 或点保释按钮）后正常掷骰</li>
          <li>三次未掷出双数：强制支付 ¥1000 出狱（付不起则破产）</li>
        </ul>
        <p><strong>🕹 托管 &amp; 🚪 退出</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li><b>🕹 托管</b>：忙的时候开启，AI 替你掷骰/买地/盖房/保释，随时取消恢复手动</li>
          <li><b>🚪 退出</b>：退出后机器人接管你的席位与资产继续游戏</li>
          <li>重新进入同一房间即可<b>收回控制权</b>（资产原样奉还）</li>
          <li>掉线会自动进入托管，不会被判破产；5 分钟未归才由机器人接管</li>
        </ul>
        <p><strong>🤖 机器人</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>开局前房主可添加机器人凑人数，独自也能开局！</li>
          <li>三档难度：🙂简单（常漏买、最多盖2级、不轻易保释）｜😐普通｜😈困难（现金充足就买、猛盖房、尽快出狱）</li>
        </ul>
        <p><strong>📈 趋势 &amp; ⚙️ 房间设置</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>点顶部「📈 趋势」查看每人每轮净资产曲线，结算时也会展示</li>
          <li>房主开局前可设起始资金（¥8k~¥30k）、开关奖池和拍卖</li>
        </ul>
        <p><strong>🤝 更多互动</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>AI 集齐一套只差一块时，会<b>主动出价</b>求购你的地，弹窗里决定卖不卖</li>
          <li>游戏内点「📋 邀请」复制链接，朋友打开<b>直接进房</b></li>
          <li>AI 会聊天吐槽，留意消息区；聊天框上方有快速表情</li>
          <li>拍卖中按 <b>1 / 2 / 3</b> 快速加价 +100/+500/+1000</li>
          <li>带建筑的土地不能直接交易（经典规则：先卖建筑）；交易需<b>对方确认</b>后才生效</li>
          <li>银行房源有限：全图共 🏠×32 / 🏨×12，垄断者囤房可造成房源短缺</li>
          <li>结算时可「💾 导出对局记录」；顶部「🎥 回放」可逐轮回看棋盘演变</li>
          <li>切到别的标签页时，标签标题会提示是否轮到你；顶部「📋 总览」可查看全局资产表</li>
          <li>「🏗 建设」「🏦 抵押」按钮会弹出选择列表，不用再满地图找格子</li>
        </ul>
        <p><strong>⏱ 回合上限</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>房主开局前可设 30/50/80 回合上限，防止拖 endless 局</li>
          <li>两张地图可选：<b>经典版</b> / <b>中国城市版</b> / <b>武林风云版</b>（经济六折快速局）</li>
          <li><b>⚔️ 团队模式</b>：2v2 分队（红蓝），队友互免租金，整队存活的获胜；🤖 机器人速度可选快速</li>
          <li>大厅「🤖 单人快速开局」一键建房 + 3机器人 + 开局；可选随机先手</li>
          <li>到上限时<b>净资产最高</b>者获胜（现金+地价）</li>
        </ul>
        <p><strong>💰 经济与破产</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>经过/停在起点领 ¥2000；所得税 ¥2000、豪华税 ¥1000</li>
          <li>付不起租金/税/卡费即破产：资产全部移交债主（或归还银行）</li>
          <li>抵押中的地产无租金收入，赎回需付 10% 利息</li>
          <li>铁路：每多持有一条租金翻倍（¥250→¥2000）；公用：骰点 ×40 / ×100</li>
        </ul>
        <p><strong>⏱ 其他</strong></p>
        <ul style="margin-left:18px;">
          <li>回合限时由房主设置（30 秒 / 1 分钟 / 2 分钟），超时自动跳过</li>
          <li>掉线后席位保留，AI 自动托管代打；5 分钟未归才由机器人接管，刷新页面即可重连</li>
          <li>音效可在 ⚙️ 设置中开关</li>
        </ul>
      </div>
    `,
    `<button class="btn btn-sm btn-primary" onclick="hideModal()">知道了</button>`
  );
}

// ────────────────────────────────────────────────────────────
// SOCKET EVENTS
// ────────────────────────────────────────────────────────────
let everConnected = false;
socket.on('connect', () => {
  const wasReconnect = everConnected;
  everConnected = true;
  state.myToken = getToken();
  // 断线重连（含服务器重启）：若此前在对局中，自动重新加入同一房间
  const savedRoom = localStorage.getItem('monopoly_room');
  if (wasReconnect && savedRoom && state.view === 'game') {
    socket.emit('join', {
      roomId: savedRoom,
      name: localStorage.getItem('monopoly_name') || getName(),
      avatar: localStorage.getItem('monopoly_avatar') || PLAYER_AVATARS[0],
      token: state.myToken,
    });
    toast('已重新连接，正在恢复对局…', 'success');
  }
  demoAutoStart();
});

// ?demo=1：单人快速开局并把自己托管给 AI，全 bot 自动推进（UI 截图 / 联调用）
// ?ui=settings|help 可在 demo 基础上直接打开对应弹窗
function demoAutoStart() {
  if (!/[?&]demo=1/.test(location.search) || state.demoStarted) return;
  state.demoStarted = true;
  localStorage.removeItem('monopoly_room');
  setTimeout(() => soloQuickStart(), 300);
  const ui = /[?&]ui=([a-z]+)/.exec(location.search)?.[1];
  // QA/截图用途：界面初始化只需 ~800ms 淡出，600ms 足够让弹窗挂上
  if (ui === 'settings') setTimeout(openSettings, 600);
  if (ui === 'help') setTimeout(openHelp, 600);
  const t = setInterval(() => {
    const g = state.game;
    if (!g || !g.started || g.ended) return;
    const me = g.players[state.myToken];
    if (me && !me.isBot && !me.delegated && !me.bankrupt) socket.emit('toggleDelegation');
    clearInterval(t);
  }, 5000);
}

socket.on('disconnect', () => {
  if (state.view === 'game') toast('⚠️ 连接断开，正在重连…', 'error');
});

socket.on('joined', ({ roomId, token, spectator }) => {
  if (token && !token.startsWith('bot_')) state.myToken = token;
  if (spectator) toast('游戏已开始，你以观战身份进入', 'info');
  showView('game');
  socket.emit('getStats', { name: localStorage.getItem('monopoly_name') || '' });
  // demo 截图模式跳过首次帮助弹窗（弹窗会盖住对局画面）
  if (!/[?&]demo=1/.test(location.search) && !localStorage.getItem('monopoly_seen_help')) {
    localStorage.setItem('monopoly_seen_help', '1');
    setTimeout(openHelp, 600);
  }
});

socket.on('state', (gameState) => {
  if (state.view !== 'game') return; // ignore stale states while in lobby
  const prev = state.game;
  const prevEnded = prev?.ended;

  // ── 音效：对比前后状态差异触发 ──
  if (prev && Sound.enabled) {
    try {
      if (gameState.dice && (!prev.dice || prev.dice[0] !== gameState.dice[0] || prev.dice[1] !== gameState.dice[1])) Sound.dice();
      let bought = false, built = false;
      gameState.board.forEach((c, i) => {
        const pc = prev.board[i];
        if (!pc) return;
        if (c.owner === state.myToken && pc.owner !== state.myToken) bought = true;
        if (c.owner === state.myToken && c.level > pc.level) built = true;
      });
      if (bought) Sound.gain();
      if (built) Sound.build();
      if (!bought && !built) {
        const pm = prev.players?.[state.myToken]?.money;
        const cm = gameState.players?.[state.myToken]?.money;
        if (typeof pm === 'number' && typeof cm === 'number') {
          if (cm > pm) Sound.gain();
          else if (cm < pm) Sound.pay();
          const d = cm - pm;
          if (d !== 0) showMoneyFloat(d);
        }
      }
      if (prev.turnIndex !== gameState.turnIndex && gameState.started && !gameState.ended &&
          gameState.order[gameState.turnIndex] === state.myToken) Sound.turn();
      if (!prev.auction && gameState.auction) Sound.gavel();
      if (!prev.debt && gameState.debt) Sound.alarm();
      if (prev.jackpot > 0 && gameState.jackpot < prev.jackpot) Sound.jackpot();
      if (!prevEnded && gameState.ended) {
        (gameState.players[state.myToken] && !gameState.players[state.myToken].bankrupt) ? Sound.win() : Sound.lose();
      }
    } catch (e) { /* sound must never break rendering */ }
  }

  // 抽卡弹窗
  if (gameState.lastCard && gameState.lastCard.ts !== state.lastCardTs) {
    state.lastCardTs = gameState.lastCard.ts;
    showCardOverlay(gameState.lastCard);
    Sound.card();
  } else if (!gameState.lastCard) {
    els.cardOverlay.classList.add('hidden');
  }

  // 棋子移动 → 闪光格
  state.flashCells = [];
  state.goldCells = [];
  if (prev) {
    if (gameState.lastRentPaid && gameState.lastRentPaid.ts !== (prev.lastRentPaid && prev.lastRentPaid.ts)) {
      state.goldCells.push(gameState.lastRentPaid.cellId);
    }
    gameState.order.forEach(pid => {
      const p = gameState.players[pid];
      const pp = prev.players && prev.players[pid];
      if (p && pp && p.pos !== pp.pos) state.flashCells.push(p.pos);
    });
  }

  state.game = gameState;
  // 服务端下发的色系数据（租金表/建造费单一数据源）覆盖前端兜底副本
  if (gameState.groups) Object.assign(GROUP_META, gameState.groups);
  if (prevEnded && !gameState.ended) state.victoryShown = false;
  if (els.roomLabel) els.roomLabel.textContent = `房间: ${gameState.id}` +
    (gameState.spectatorCount > 0 ? ` · 👀${gameState.spectatorCount}` : '');
  render();
});

socket.on('roomList', (list) => {
  lastRooms = Array.isArray(list) ? list : [];
  renderLobbyRooms();
});

function renderRejoinBanner() {
  if (!els.lobbyRoomList) return;
  const saved = localStorage.getItem('monopoly_room');
  const r = saved && lastRooms.find(x => x.id === saved && x.started && !x.ended);
  let el = document.getElementById('rejoinBanner');
  if (r && !el) {
    el = document.createElement('div');
    el.id = 'rejoinBanner';
    el.className = 'rejoin-banner';
    el.innerHTML = `<span>🎮 你在房间 <b>${escapeHtml(r.id)}</b> 的对局还在进行中</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = '重连上一局';
    btn.onclick = () => joinRoom(r.id);
    el.appendChild(btn);
    els.lobbyRoomList.parentElement.insertBefore(el, els.lobbyRoomList);
  } else if (!r && el) {
    el.remove();
  }
}

function renderLobbyRooms() {
  if (!els.lobbyRoomList || state.view !== 'lobby') return;
  const list = lastRooms.filter(r => r.playerCount > 0);
  if (els.lobbyEmpty) els.lobbyEmpty.style.display = list.length ? 'none' : '';
  els.lobbyRoomList.innerHTML = '';
  list.forEach(r => {
    const div = document.createElement('div');
    div.className = 'lobby-room-item';
    div.innerHTML = `
      <span class="lr-id">🏠 ${escapeHtml(r.id)}${r.locked ? ' 🔒' : ''}</span>
      <span class="lr-meta">${r.mapName || '经典版'} · ${r.playerCount}/8 人 ${r.started ? '· 游戏中' : r.ended ? '· 已结束' : '· 等待中'}${r.spectators > 0 ? ` · 👀${r.spectators}` : ''}</span>
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = r.started ? '观战' : '加入';
    btn.onclick = () => joinRoom(r.id);
    div.appendChild(btn);
    els.lobbyRoomList.appendChild(div);
  });
  renderRejoinBanner();
}

socket.on('stats', (data) => {
  const list = data && data.top ? data.top : (Array.isArray(data) ? data : []);
  const mine = data && data.mine;
  // 成就墙（8 枚：点亮 / 未解锁）
  const ACHIEVEMENTS = [
    { icon: '🥇', name: '首胜', desc: '赢下第一局', got: mine && mine.wins >= 1 },
    { icon: '🏆', name: '五胜上将', desc: '累计 5 胜', got: mine && mine.wins >= 5 },
    { icon: '🎖', name: '十局常客', desc: '累计 10 局', got: mine && mine.games >= 10 },
    { icon: '💰', name: '家财万贯', desc: '巅峰净资产 ¥50,000', got: mine && mine.bestNet >= 50000 },
    { icon: '🏦', name: '收租达人', desc: '生涯收租 ¥20,000', got: mine && (mine.rentEarned || 0) >= 20000 },
    { icon: '🎲', name: '骰子狂人', desc: '生涯掷骰 200 次', got: mine && (mine.rolls || 0) >= 200 },
    { icon: '🏗', name: '圈地运动', desc: '生涯购地 15 块', got: mine && (mine.propsBought || 0) >= 15 },
    { icon: '🚔', name: '铁窗泪', desc: '入狱 3 次（也算成就）', got: mine && (mine.jailed || 0) >= 3 },
    { icon: '⚔️', name: '并肩作战', desc: '团队模式获胜 1 次', got: mine && (mine.teamWins || 0) >= 1 },
  ];
  const recentEl = document.getElementById('recentGames');
  if (recentEl) {
    const recent = (data && data.recent) || [];
    recentEl.innerHTML = recent.length
      ? recent.map(g2 => {
          const d = new Date(g2.date);
          const ds = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          const mapName = { classic: '经典', china: '中国', wulin: '武林' }[g2.map] || g2.map;
          return `<div class="stats-row"><span class="sr-rank">🎲</span><span class="sr-name">${escapeHtml(g2.winner || '无胜者')}</span><span class="sr-meta">${ds} · ${mapName} · ${g2.rounds}轮 · ${g2.players.length}人</span></div>`;
        }).join('')
      : '<p class="lobby-empty">暂无历史对局</p>';
  }
  if (els.myStatsLine) {
    const base = mine ? `📊 我的战绩（${escapeHtml(mine.name)}）：${mine.wins} 胜 / ${mine.games} 局${mine.bestNet ? ' · 巅峰净资产 ¥' + mine.bestNet.toLocaleString() : ''}` : '输入昵称开始你的第一局，生涯成就将永久记录';
    const wall = `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${ACHIEVEMENTS.map(a => `
      <span class="ach ${a.got ? 'got' : 'locked'}" title="${a.name}：${a.desc}">${a.icon}<i>${a.name}</i></span>`).join('')}</div>`;
    els.myStatsLine.innerHTML = (base ? base + '<br>' : '') + wall;
  }
  if (!els.lobbyStats) return;
  if (!list || !list.length) return;
  els.lobbyStats.innerHTML = list.map((s, i) =>
    `<div class="stats-row"><span class="sr-rank">${['🥇','🥈','🥉'][i] || (i + 1)}</span><span class="sr-name">${escapeHtml(s.name)}</span><span class="sr-meta">${s.wins}胜 / ${s.games}局${s.bestNet ? ' · 巅峰 ¥' + s.bestNet.toLocaleString() : ''}</span></div>`
  ).join('');
});

socket.on('msg', (message) => toast(message, 'info'));

socket.on('connect_error', () => {
  toast('连接服务器失败，请稍后重试', 'error');
});

// ────────────────────────────────────────────────────────────
// MAIN RENDER
// ────────────────────────────────────────────────────────────
function render() {
  if (!state.game) return;

  const me = state.game.players[state.myToken];

  // Header info
  if (me) {
    els.myInfo.style.display = 'flex';
    els.myName.textContent = me.name;
    els.myMoney.textContent = formatMoney(me.money);
    els.myAvatar.textContent = me.avatar || me.name.charAt(0);
    els.myAvatar.style.background = playerColor(state.myToken);
  } else {
    // 观战身份展示
    els.myInfo.style.display = 'flex';
    els.myName.textContent = '观众';
    els.myMoney.textContent = '👀 观战中';
    els.myMoney.style.color = 'var(--text-tertiary)';
    els.myAvatar.textContent = '👀';
    els.myAvatar.style.background = 'var(--bg-darker)';
  }
  if (me) els.myMoney.style.color = '';

  els.inviteBtn.style.display = state.game ? '' : 'none';
  els.replayBtn.style.display = (state.game && state.game.started && (state.game.replay || []).length >= 2) ? '' : 'none';
  els.chartBtn.style.display = (state.game && state.game.started && (state.game.nwHistory || []).length >= 2) ? '' : 'none';
  els.overviewBtn.style.display = state.game && state.game.started ? '' : 'none';
  updateWindowTitle();
  maybeShowTrade();
  renderBoard();
  renderPlayers();
  renderControls();
  renderLog();
  updateTurnBanner();
  animateDice();
  renderAuction();
  maybeShowProposal();
}

// 标签页标题：切到别的标签也能知道是否轮到自己
function updateWindowTitle() {
  const BASE = '大富翁在线 - Monopoly Online';
  let title = BASE;
  const g = state.game;
  if (g && g.started && !g.ended) {
    if (g.diceAnim) title = '🎲 掷骰中… · 大富翁';
    else if (g.order[g.turnIndex] === state.myToken) title = '🎯 轮到你了！· 大富翁';
    else {
      const cur = g.players[g.order[g.turnIndex]];
      title = `⏳ ${cur ? cur.name : ''} 的回合 · 大富翁`;
    }
  }
  if (document.title !== title) document.title = title;
}

// ────────────────────────────────────────────────────────────
// 对局回放（滑杆逐轮查看棋盘快照）
function openReplay() {
  const g = state.game;
  const snaps = (g && g.replay) || [];
  if (snaps.length < 2) { toast('至少打完 2 轮后才有回放', 'info'); return; }
  state.replayIdx = snaps.length - 1;
  hideModal();
  render();
  const banner = document.createElement('div');
  banner.id = 'replayBanner';
  banner.className = 'replay-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', '对局回放控制');
  banner.innerHTML = `
    <span>🎥 对局回放 · 第 <b id="rpRound">${snaps[state.replayIdx].r}</b> 轮 / 共 ${snaps.length} 帧</span>
    <button class="btn btn-sm btn-ghost" id="rpPrev" aria-label="上一轮" title="上一轮">◀</button>
    <input type="range" id="rpSlider" aria-label="回放进度" min="0" max="${snaps.length - 1}" value="${state.replayIdx}" style="flex:1;" />
    <button class="btn btn-sm btn-ghost" id="rpNext" aria-label="下一轮" title="下一轮">▶</button>
    <button class="btn btn-sm btn-secondary" id="rpExit">退出回放</button>`;
  const section = document.querySelector('.board-section');
  if (section) section.insertBefore(banner, section.firstChild);
  const gotoFrame = (idx) => {
    state.replayIdx = Math.max(0, Math.min(snaps.length - 1, idx));
    slider.value = String(state.replayIdx);
    document.getElementById('rpRound').textContent = snaps[state.replayIdx].r;
    render();
  };
  const slider = document.getElementById('rpSlider');
  slider.addEventListener('input', () => gotoFrame(Number(slider.value)));
  document.getElementById('rpPrev').addEventListener('click', () => gotoFrame(state.replayIdx - 1));
  document.getElementById('rpNext').addEventListener('click', () => gotoFrame(state.replayIdx + 1));
  document.getElementById('rpExit').addEventListener('click', exitReplay);
}

function exitReplay() {
  state.replayIdx = null;
  const b = document.getElementById('replayBanner');
  if (b) b.remove();
  render();
}

window.exitReplay = exitReplay;

// 净资产趋势图
// ────────────────────────────────────────────────────────────
function drawNwChart(canvas, history) {
  if (!canvas || !history || history.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.min(520, (canvas.parentElement ? canvas.parentElement.clientWidth : 480) || 480);
  const cssH = 220;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const tokens = new Set();
  history.forEach(s => Object.keys(s.v).forEach(t => tokens.add(t)));
  const allVals = [];
  history.forEach(s => Object.values(s.v).forEach(x => allVals.push(x)));
  if (!allVals.length) return;
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 2000; max += 2000; }
  const padY = (max - min) * 0.12;
  min -= padY; max += padY;
  const padL = 56, padR = 14, padT = 10, padB = 24;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  const r0 = history[0].r, r1 = history[history.length - 1].r || 1;
  const xs = r => padL + (history.length === 1 ? W / 2 : ((r - r0) / ((r1 - r0) || 1)) * W);
  const ys = v => padT + H - ((v - min) / (max - min)) * H;

  ctx.font = '10px sans-serif';
  for (let i = 0; i <= 3; i++) {
    const v = min + (max - min) * i / 3;
    const y = ys(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillStyle = '#7a84a0';
    ctx.textAlign = 'right';
    ctx.fillText('¥' + Math.round(v / 1000) + 'k', padL - 6, y + 3);
  }
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(history.length / 8));
  history.forEach((s, i) => {
    if (i % step === 0 || i === history.length - 1) {
      ctx.fillStyle = '#7a84a0';
      ctx.fillText('R' + s.r, Math.max(padL + 8, Math.min(padL + W - 8, xs(s.r))), cssH - 8);
    }
  });

  tokens.forEach(tok => {
    const pts = history.filter(s => s.v[tok] !== undefined).map(s => [xs(s.r), ys(s.v[tok])]);
    if (!pts.length) return;
    const color = playerColor(tok);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(last[0], last[1], 3, 0, Math.PI * 2); ctx.fill();
  });
}

function nwLegendHtml() {
  return (state.game && state.game.order || []).map(pid => {
    const p = state.game.players[pid];
    if (!p) return '';
    return `<span class="gchip solid" style="background:${playerColor(pid)};color:${textOn(playerColor(pid))}">${escapeHtml(p.name)}${p.bankrupt ? ' 💀' : ''}</span>`;
  }).join('');
}

function openNwChart() {
  const h = (state.game && state.game.nwHistory) || [];
  showModal(
    '📈 净资产趋势',
    `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${nwLegendHtml()}</div>
     <div style="display:flex;justify-content:center;"><canvas id="nwCanvas"></canvas></div>
     ${h.length < 2 ? '<p style="font-size:12px;color:var(--text-tertiary);text-align:center;">至少打完 1 轮后出现趋势线</p>' : ''}`,
    `<button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>`
  );
  requestAnimationFrame(() => drawNwChart(document.getElementById('nwCanvas'), h));
}

// ────────────────────────────────────────────────────────────
// AI 购地提案弹窗
// ────────────────────────────────────────────────────────────
function maybeShowProposal() {
  const pr = state.game && state.game.proposal;
  if (pr && pr.to === state.myToken) {
    if (state.proposalShownSeq === pr.seq) return;
    state.proposalShownSeq = pr.seq;
    state.proposalModalOpen = true;
    const cell = state.game.board[pr.cellId];
    const from = state.game.players[pr.from];
    const market = cell ? cell.price : 0;
    showModal(
      '🤝 收到购地提议！',
      `<div style="font-size:15px;line-height:1.9;text-align:center;padding:6px 0;">
         ${from ? from.avatar + ' <b>' + escapeHtml(from.name) + '</b>' : '对方'} 想以<br>
         <b style="color:var(--accent-warning);font-size:22px;">¥${pr.price.toLocaleString()}</b><br>
         买下你的 <b>「${escapeHtml(cell ? cell.name : '?')}」</b>（市价 ¥${market.toLocaleString()}）
         <p style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">15 秒内不回应将自动取消</p>
       </div>`,
      `<button class="btn btn-primary" onclick="answerProposal(${pr.seq}, true)">✅ 卖了（+¥${pr.price.toLocaleString()}）</button>
       <button class="btn btn-secondary" onclick="answerProposal(${pr.seq}, false)">❌ 不卖</button>`,
      // 需应答：ESC / 遮罩不关，只能卖 / 不卖，或 15 秒后服务端自动取消
      false
    );
    Sound.turn();
  } else if (!pr && state.proposalModalOpen) {
    // 提议已超时/被撤回
    state.proposalModalOpen = false;
    hideModal();
  }
}

window.answerProposal = function(seq, accept) {
  state.proposalModalOpen = false;
  hideModal();
  socket.emit('proposalResp', { seq, accept });
};

// ────────────────────────────────────────────────────────────
// 玩家交易提议确认弹窗
// ────────────────────────────────────────────────────────────
function maybeShowTrade() {
  const t = state.game && state.game.trade;
  if (t && t.to === state.myToken) {
    if (state.tradeShownSeq === t.seq) return;
    state.tradeShownSeq = t.seq;
    state.tradeModalOpen = true;
    const from = state.game.players[t.from];
    const fmt = ids => (ids || []).map(id => {
      const c = state.game.board[id];
      return c ? escapeHtml(c.name) : '';
    }).filter(Boolean).join('、') || '无';
    showModal(
      '🤝 收到交易提议！',
      `<p style="font-size:15px;">${from ? from.avatar + ' <b>' + escapeHtml(from.name) + '</b>' : '对方'} 提议：</p>
       <div style="font-size:14px;line-height:2;margin:8px 0;">
         <p>📦 TA 给你：现金 <b style="color:var(--accent-success);">¥${(t.giveMoney || 0).toLocaleString()}</b> ｜ 地产：${fmt(t.giveProps)}</p>
         <p>💸 TA 想要：现金 <b style="color:var(--accent-danger);">¥${(t.getMoney || 0).toLocaleString()}</b> ｜ 地产：${fmt(t.getProps)}</p>
       </div>
       <p style="font-size:12px;color:var(--text-tertiary);">剩余 <b id="tradeCd">30</b> 秒，超时自动取消</p>`,
      `<button class="btn btn-primary" onclick="answerTrade(${t.seq}, true)">✅ 接受</button>
       <button class="btn btn-secondary" onclick="answerTrade(${t.seq}, false)">❌ 拒绝</button>`,
      // 需应答：ESC / 遮罩不关，只能接受 / 拒绝，或超时自动取消
      false
    );
    Sound.turn();
  } else if (!t && state.tradeModalOpen) {
    state.tradeModalOpen = false;
    hideModal();
  }
}

window.answerTrade = function(seq, accept) {
  state.tradeModalOpen = false;
  hideModal();
  socket.emit('tradeResp', { seq, accept });
};

// ────────────────────────────────────────────────────────────
// MONEY FLOAT（金钱变动飘字）
// ────────────────────────────────────────────────────────────
function showMoneyFloat(delta) {
  if (!els.moneyFloatLayer || !delta) return;
  const el = document.createElement('div');
  el.className = 'money-float ' + (delta > 0 ? 'gain' : 'lose');
  el.textContent = (delta > 0 ? '+' : '-') + '¥' + Math.abs(delta).toLocaleString();
  el.style.left = (38 + Math.random() * 24) + '%';
  els.moneyFloatLayer.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

// ────────────────────────────────────────────────────────────
// DRAWN CARD OVERLAY
// ────────────────────────────────────────────────────────────
let cardHideTimer = null;
function showCardOverlay(card) {
  if (!els.cardOverlay || !card) return;
  els.dcIcon.textContent = card.type === 'chance' ? '❓' : '📦';
  els.dcType.textContent = card.type === 'chance' ? '机 会' : '命运基金';
  els.cardOverlay.classList.toggle('chance', card.type === 'chance');
  els.cardOverlay.classList.toggle('chest', card.type !== 'chance');
  els.dcText.textContent = card.text;
  els.cardOverlay.classList.remove('hidden');
  clearTimeout(cardHideTimer);
  cardHideTimer = setTimeout(() => els.cardOverlay.classList.add('hidden'), 3200);
}

// ────────────────────────────────────────────────────────────
// AUCTION PANEL
// ────────────────────────────────────────────────────────────
function renderAuction() {
  const a = state.game?.auction;
  if (!a || a.no === state.auctionHiddenNo) {
    // 无拍卖：尽早返回，且仅在面板确实可见时做一次 DOM 写入（避免每秒空跑）
    if (!els.auctionPanel.classList.contains('hidden')) {
      els.auctionPanel.classList.add('hidden');
      setAriaExpanded(els.apHideBtn, false);
      state.lastTickSecond = null;
    }
    return;
  }
  const cell = state.game.board[a.cellId];
  if (!cell) { els.auctionPanel.classList.add('hidden'); setAriaExpanded(els.apHideBtn, false); return; }

  els.auctionPanel.classList.remove('hidden');
  setAriaExpanded(els.apHideBtn, true);
  els.apName.textContent = `${cell.name}（原价 ¥${cell.price.toLocaleString()}）`;
  els.apTopBid.textContent = '¥' + a.topBid.toLocaleString();
  if (a.topBidder) {
    const p = state.game.players[a.topBidder];
    els.apTopBidder.textContent = p ? `（${p.avatar} ${p.name}）` : '';
  } else {
    els.apTopBidder.textContent = '（尚未出价）';
  }
  const left = Math.max(0, Math.ceil((a.endsAt - Date.now()) / 1000));
  els.apTimer.textContent = `${left}s`;
  els.apTimer.style.color = left <= 5 ? 'var(--accent-danger)' : '';
  els.auctionPanel.classList.toggle('urgent', left <= 5 && left > 0);
  if (left <= 3 && left > 0 && state.lastTickSecond !== left && Sound.enabled) {
    state.lastTickSecond = left;
    Sound.play([[880, 0.05, 0]], 0.06);
  }

  const me = state.game.players[state.myToken];
  const myTurnToBid = me && !me.bankrupt;
  [els.apBid100, els.apBid500, els.apBid1000].forEach((btn, i) => {
    const step = [100, 500, 1000][i];
    btn.disabled = !myTurnToBid || (a.topBid + step) > (me?.money ?? 0);
  });

  if (els.apRent) {
    const meta = cell.group ? GROUP_META[cell.group] : null;
    let rentTxt = '';
    if (cell.type === 'city' && meta) rentTxt = `租金：空地 ¥${Math.round(meta.rents[0] * rentMul()).toLocaleString()} → 🏨 ¥${Math.round(meta.rents[5] * rentMul()).toLocaleString()}（每级建造 ¥${Math.floor(meta.houseCost * ((state.game && state.game.houseMul) || 1)).toLocaleString()}）`;
    else if (cell.type === 'railroad') rentTxt = '租金：¥250 → ¥2000（按持有铁路数）';
    else if (cell.type === 'utility') rentTxt = '租金：骰子点数 ×40 / ×100';
    els.apRent.textContent = rentTxt;
  }
  if (els.apHistory) {
    const lines = (a.bids || []).slice(-4).map(b => `${escapeHtml(b.name)} ¥${b.amount.toLocaleString()}`);
    els.apHistory.innerHTML = lines.length ? lines.join(' · ') : '暂无出价，抢个头筹？';
  }
}

window.renderAuction = renderAuction;

// ────────────────────────────────────────────────────────────
// ZOOM
// ────────────────────────────────────────────────────────────
function changeZoom(delta) {
  state.zoom = Math.max(0.6, Math.min(1.8, state.zoom + delta));
  els.boardWrapper.style.transform = `scale(${state.zoom})`;
}

function setZoom(val) {
  state.zoom = val;
  els.boardWrapper.style.transform = `scale(${state.zoom})`;
}

// ────────────────────────────────────────────────────────────
// EXPORTS & START
// ────────────────────────────────────────────────────────────
window.socket = socket;
window.state = state;
window.PLAYER_COLORS = PLAYER_COLORS;
window.openHelp = openHelp;
window.kickOneBot = function(id) {
  hideModal();
  socket.emit('kickBot', { token: id });
};

// ── 对局记录导出 ──
window.exportGameLog = function() {
  const g = state.game;
  if (!g) return;
  const lines = [];
  lines.push(`大富翁在线 对局记录 - 房间 ${g.id}`);
  lines.push(`导出时间: ${new Date().toLocaleString()}`);
  lines.push(`轮数: ${g.roundCount}  玩家: ${g.order.map(id => { const p = g.players[id]; return p ? p.name : '?'; }).join(', ')}`);
  lines.push('='.repeat(44));
  const all = [
    ...g.logs.map(l => ({ ...l, kind: '日志' })),
    ...g.chats.map(c => ({ ...c, kind: '聊天' })),
  ].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  all.forEach(e => {
    const t = new Date(e.ts || 0).toLocaleTimeString();
    lines.push(`[${t}] (${e.kind}) ${e.kind === '聊天' ? (e.from || '?') + ': ' : ''}${e.text || ''}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `monopoly-${g.id}-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
