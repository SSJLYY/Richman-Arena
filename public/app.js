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
  lastTickSecond: null, // 拍卖倒计时已滴答的秒数      // 本次刷新需要闪烁的格子
  proposalShownSeq: 0, // 已展示过的购地提案
  proposalModalOpen: false,
  tradeShownSeq: 0,    // 已展示过的交易提议
  tradeModalOpen: false,
};
let lastRooms = [];

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
  play(notes, vol = 0.1) {
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
  roomSettingsRow: $('roomSettingsRow'),
  mapSel: $('mapSel'),
  turnTimeSel: $('turnTimeSel'),
  myStatsLine: $('myStatsLine'),
  moneyFloatLayer: $('moneyFloatLayer'),
  lobbySoloBtn: $('lobbySoloBtn'),
  apRent: $('apRent'),
  startMoneySel: $('startMoneySel'),
  jackpotChk: $('jackpotChk'),
  auctionChk: $('auctionChk'),
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

function showModal(title, html, footer = '') {
  els.modalRoot.innerHTML = `
    <div class="modal">
      <div class="modal-content">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close" onclick="hideModal()">×</button>
        </div>
        <div class="modal-body">${html}</div>
        <div class="modal-footer">${footer}</div>
      </div>
    </div>
  `;
}

function hideModal() { els.modalRoot.innerHTML = ''; }
window.hideModal = hideModal;

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
  socket.emit('join', {
    roomId,
    name: localStorage.getItem('monopoly_name') || getName(),
    avatar: localStorage.getItem('monopoly_avatar') || PLAYER_AVATARS[0],
    token: state.myToken,
  });
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
    `<p style="font-size:13px;word-break:break-all;background:var(--bg-darker);padding:10px;border-radius:8px;color:var(--text-primary);">${escapeHtml(url)}</p>
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
  PLAYER_AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'avatar-option' + (a === current ? ' selected' : '');
    d.textContent = a;
    d.onclick = () => {
      state.selectedAvatar = a;
      els.avatarGrid.querySelectorAll('.avatar-option').forEach(x => x.classList.remove('selected'));
      d.classList.add('selected');
    };
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
  document.querySelectorAll('#quickReactions button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.game) socket.emit('chat', btn.dataset.emoji);
    });
  });
  els.startMoneySel?.addEventListener('change', () => socket.emit('setSettings', { startMoney: Number(els.startMoneySel.value) }));
  els.mapSel?.addEventListener('change', () => socket.emit('setSettings', { map: els.mapSel.value }));
  els.turnTimeSel?.addEventListener('change', () => socket.emit('setSettings', { turnTimeoutMs: Number(els.turnTimeSel.value) }));
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
  });
  els.tradeBtn?.addEventListener('click', () => openTradeModal());
  els.botBtn?.addEventListener('click', () => openBotModal());
  els.settingsBtn?.addEventListener('click', () => openSettings());
  els.helpBtn?.addEventListener('click', () => openHelp());

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
    if (e.key === 'h' || e.key === 'H') { if (!e.repeat) openHelp(); return; }
    if (state.game?.ended) {
      if (e.key === 'Escape') window.location.reload();
      if (e.key === 'Enter') { e.preventDefault(); socket.emit('reset'); }
      return;
    }

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

function renderBoard() {
  if (!state.game) return;
  // 只清理格子与中央面板，tokenLayer 保留以支持移动过渡动画
  Array.from(els.board.children).forEach(ch => {
    if (ch !== els.tokenLayer) ch.remove();
  });

  const monopolies = computeMonopolies();
  state.game.board.forEach(cell => {
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
    const ICONS = { go:'🏁', jail:'🔒', parking:'🅿️', gotojail:'🚔', chance:'❓', chest:'📦', tax:'🏛️', railroad:'🚂', utility:'💡' };
    if (ICONS[cell.type] && cell.type !== 'city') {
      const icon = document.createElement('div');
      icon.className = 'cell-icon';
      icon.textContent = ICONS[cell.type];
      div.appendChild(icon);
    }

    // Name
    const nameEl = document.createElement('div');
    nameEl.className = 'cell-name';
    nameEl.textContent = cell.name;
    div.appendChild(nameEl);

    // Price
    if (cell.price > 0) {
      const priceEl = document.createElement('div');
      priceEl.className = 'cell-price';
      priceEl.textContent = `¥${(cell.price / 100) % 1 === 0 ? cell.price / 100 : cell.price}`;
      div.appendChild(priceEl);
    }

    // House level indicator
    if (cell.type === 'city' && cell.level > 0) {
      const lv = document.createElement('div');
      lv.className = 'house-badge';
      lv.textContent = cell.level >= 5 ? '🏨' : '🏠'.repeat(cell.level);
      div.appendChild(lv);
    }

    // Owner dot
    if (cell.owner) {
      const dot = document.createElement('div');
      dot.className = 'owner-dot';
      dot.style.background = playerColor(cell.owner);
      div.appendChild(dot);
    }

    // Mortgaged badge
    if (cell.mortgaged) {
      div.classList.add('mortgaged');
    }

    // Current rent badge (server-computed; -1 = dice-based utility)
    if (cell.owner && !cell.mortgaged &&
        (cell.type === 'city' || cell.type === 'railroad' || cell.type === 'utility')) {
      const rb = document.createElement('div');
      rb.className = 'rent-badge';
      rb.textContent = (cell.rent === -1) ? '骰×40' : '¥' + cell.rent;
      div.appendChild(rb);
    }

    if (state.flashCells && state.flashCells.includes(cell.id)) div.classList.add('cell-flash');
    if (state.goldCells && state.goldCells.includes(cell.id)) div.classList.add('cell-gold');
    if (state.game.auction && state.game.auction.cellId === cell.id) div.classList.add('cell-auction');
    if (cell.group && monopolies[cell.group]) {
      div.classList.add('monopoly-cell');
      div.style.setProperty('--mono-color', playerColor(monopolies[cell.group]));
    }

    const ownerName = cell.owner ? (state.game.players[cell.owner]?.name || '') : '';
    div.title = `${cell.name}${cell.price ? ' · ¥' + cell.price : ''}` +
      `${ownerName ? ' · ' + ownerName : ''}` +
      `${cell.mortgaged ? ' · 已抵押' : ''}` +
      `${cell.rent > 0 ? ' · 租金 ¥' + cell.rent : ''}`;

    // Click: property details
    div.onclick = () => openPropertyModal(cell.id);
    els.board.appendChild(div);
  });

  // ── 棋盘中央信息面板（显式定位在 11×11 网格中心：行2-10 列2-10）──
  const center = document.createElement('div');
  center.className = 'board-center';
  center.style.gridArea = '2 / 2 / 11 / 11';
  const dice = state.game.dice;
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const cur = state.game.players[state.game.order[state.game.turnIndex]];
  let turnLine = '等待开始';
  if (state.game.started) {
    if (state.game.ended) turnLine = '🏁 已结束';
    else turnLine = `轮到 ${cur ? (cur.avatar + ' ' + escapeHtml(cur.name)) : '...'}${cur && cur.isBot ? ' 🤖' : ''}`;
  }
  center.innerHTML = `
    <div class="bc-logo">MONOPOLY</div>
    <div class="bc-sub">大富翁在线</div>
    <div class="bc-dice">${dice ? `${faces[dice[0] - 1]}${faces[dice[1] - 1]} <b>${dice[0] + dice[1]}</b>` : '🎲🎲'}</div>
    <div class="bc-turn">${turnLine}</div>
    <div class="bc-round">第 ${state.game.roundCount || 1}${state.game.maxRounds ? '/' + state.game.maxRounds : ''} 回合 · ${state.game.order.length} 人${state.game.startedAt ? ' · 已用 ' + fmtElapsed(state.game.startedAt) : ''}</div>
    ${state.game.jackpot > 0 ? `<div class="bc-jackpot">🎁 停车场奖池 ¥${state.game.jackpot.toLocaleString()}</div>` : ''}
  `;
  els.board.appendChild(center);
  renderTokens();
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
      el.addEventListener('click', () => openPlayerModal(pid));
      layer.appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
      el.dataset.dispPos = String(p.pos);
      placeToken(el, p.pos, pid, '0s');
    }
    el.style.background = playerColor(pid);
    el.textContent = p.avatar || p.name.charAt(0);
    el.title = p.name + (pid === state.myToken ? ' (我)' : '');

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
      <p><strong>租金表：</strong>空地 ¥${meta.rents[0].toLocaleString()}${ownsAll && cell.owner ? '（集齐全组 ×2 = ¥' + (meta.rents[0] * 2).toLocaleString() + '）' : ''}</p>
      <p style="padding-left:12px;">🏠1房 ¥${meta.rents[1].toLocaleString()} · 🏠2房 ¥${meta.rents[2].toLocaleString()} · 🏠3房 ¥${meta.rents[3].toLocaleString()} · 🏠4房 ¥${meta.rents[4].toLocaleString()} · 🏨酒店 ¥${meta.rents[5].toLocaleString()}</p>
      <p><strong>每级建造费：</strong>¥${meta.houseCost.toLocaleString()}（出售退一半）</p>
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
        ${!mine && onIt && !cell.owner && cell.price > 0 && state.game.players[state.myToken]?.money >= cell.price
          ? '<p style="color:var(--accent-success);">✅ 你在此格，可以购买</p>' : ''}
      </div>
    `,
    `
      ${!mine && !cell.owner && onIt && cell.price > 0 && state.game.players[state.myToken]?.money >= cell.price
        ? `<button class="btn btn-sm btn-primary" onclick="hideModal();socket.emit('buy')">💰 购买 ¥${cell.price.toLocaleString()}</button>` : ''}
      ${actions}
      <button class="btn btn-sm btn-ghost" onclick="hideModal()">关闭</button>
    `
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
    const cost = meta ? meta.houseCost : 0;
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
    return `<span class="gchip${cls}" style="background:${meta.color};" title="${meta.name}${n === total ? '：已集齐！' : n === total - 1 ? '：差 1 块集齐！' : ''}">${meta.name} ${n}/${total}</span>`;
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
  els.playersList.innerHTML = '';
  const ordered = [...state.game.order].sort((a, b) => {
    const pa = state.game.players[a], pb = state.game.players[b];
    return (pa && pa.bankrupt ? 1 : 0) - (pb && pb.bankrupt ? 1 : 0);
  });
  ordered.forEach(pid => {
    const p = state.game.players[pid];
    if (!p) return;
    const isCurrentTurn = state.game.order[state.game.turnIndex] === pid && state.game.started && !state.game.ended;
    const isMe = pid === state.myToken;
    const isHost = pid === state.game.hostToken;

    const div = document.createElement('div');
    div.className = `player-item ${isCurrentTurn ? 'active' : ''} ${p.bankrupt ? 'bankrupt' : ''}`;

    const dot = document.createElement('div');
    dot.className = 'player-dot';
    dot.style.background = playerColor(pid);
    dot.innerHTML = `<span style="font-size:10px;">${p.avatar}</span>`;

    const info = document.createElement('div');
    info.className = 'player-info';
    info.innerHTML = `
      <div class="player-name" style="color:${playerColor(pid)}">
        ${escapeHtml(p.name)}${p.isBot ? ` <span class="bot-tag">BOT${p.botLevel === 'easy' ? '🙂' : p.botLevel === 'hard' ? '😈' : ''}</span>` : ''}
        ${isMe ? ' <span style="color:#4fc3f7">(我)</span>' : ''}${isHost ? ' 👑' : ''}
      </div>
      <div class="player-status">
        ${statusLine(p, isMe)}
        ${p.jailFreeCards > 0 ? ` | 🎴×${p.jailFreeCards}` : ''}
      </div>
      ${groupChipsHtml(p)}
    `;

    const money = document.createElement('div');
    money.className = 'player-money';
    money.style.color = p.money > 30000 ? '#4caf50' : p.money > 0 ? '#ffeb3b' : '#ff5252';
    money.textContent = formatMoney(p.money);

    div.appendChild(dot);
    div.appendChild(info);
    div.appendChild(money);
    div.style.cursor = 'pointer';
    div.title = '点击查看资产总览';
    div.addEventListener('click', () => openPlayerModal(pid));
    els.playersList.appendChild(div);
  });
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
  if (idlePhase && isHost && state.game.settings) {
    const st = state.game.settings;
    if (String(st.startMoney) !== els.startMoneySel.value) els.startMoneySel.value = String(st.startMoney);
    if (els.jackpotChk.checked !== !!st.jackpotOn) els.jackpotChk.checked = !!st.jackpotOn;
    if (els.auctionChk.checked !== !!st.auctionOn) els.auctionChk.checked = !!st.auctionOn;
    if (state.game.mapId && els.mapSel.value !== state.game.mapId) els.mapSel.value = state.game.mapId;
    if (String(st.turnTimeoutMs || 120000) !== els.turnTimeSel.value) els.turnTimeSel.value = String(st.turnTimeoutMs || 120000);
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
  els.rollBtn.innerHTML = `<span class="btn-icon">🎲</span><span>${inJail && myTurn ? '试掷双数出狱' : '掷骰子'}</span>`;
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

  els.actionHint.textContent = hint;
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
      ${richHtml}
      ${hotHtml}
      ${(state.game.nwHistory || []).length >= 2 ? '<div style="display:flex;justify-content:center;margin-bottom:10px;"><canvas id="nwCanvas"></canvas></div>' : ''}
      <table class="stats-table">
        <thead><tr><th>#</th><th>玩家</th><th>现金</th><th>地产</th><th>建筑</th><th>净资产</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `,
    `<button class="btn btn-secondary" onclick="exportGameLog()">💾 导出对局记录</button>
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
  els.log.innerHTML = '';

  const combined = [];
  state.game.chats.forEach(c => combined.push({ ...c, type: c.from === '系统' ? 'system' : 'chat' }));
  state.game.logs.forEach(l => combined.push({ ...l, type: 'game' }));
  combined.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const filtered = state.logFilter === 'all' ? combined : combined.filter(e => e.type === state.logFilter);

  filtered.slice(-60).reverse().forEach(item => {
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
            return `<span class="bot-chip">${b.avatar} ${escapeHtml(b.name)} ${face}<button class="bot-chip-x" title="移除该机器人" onclick="kickOneBot('${id}')">✕</button></span>`;
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
    html += `<button class="btn btn-sm" style="background:${color};" onclick="selectTradeTarget('${p.id}')">${p.avatar} ${escapeHtml(p.name)}${tag} ¥${p.money.toLocaleString()}</button>`;
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
        <label>现金 ¥ <input type="number" id="giveMoney" value="0" min="0" max="${state.game.players[state.myToken].money}" style="width:90px;background:var(--bg-darker);color:var(--text-primary);border:1px solid var(--border-dark);border-radius:4px;padding:4px;"></label>
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
        <label>现金 ¥ <input type="number" id="getMoney" value="0" min="0" max="${target.money}" style="width:90px;background:var(--bg-darker);color:var(--text-primary);border:1px solid var(--border-dark);border-radius:4px;padding:4px;"></label>
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
    `
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
        <label>你的昵称</label>
        <input type="text" id="nameInput" maxlength="16" value="${escapeHtml(localStorage.getItem('monopoly_name') || '')}"
          style="background:var(--bg-darker);color:var(--text-primary);border:1px solid var(--border-dark);border-radius:6px;padding:8px;width:180px;">
      </div>
      <div class="setting-item">
        <label>头像</label>
        <select id="avatarInput" style="background:var(--bg-darker);color:var(--text-primary);border:1px solid var(--border-dark);border-radius:6px;padding:8px;">
          ${PLAYER_AVATARS.map(a => {
            const cur = state.game?.players?.[state.myToken]?.avatar || localStorage.getItem('monopoly_avatar');
            return `<option value="${a}" ${cur === a ? 'selected' : ''}>${a}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="setting-item">
        <label>音效</label>
        <label class="toggle"><input type="checkbox" id="soundInput" ${Sound.enabled ? 'checked' : ''}><span class="slider"></span></label>
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
  const soundOn = document.getElementById('soundInput')?.checked;
  if (name) localStorage.setItem('monopoly_name', name.slice(0, 16));
  if (avatar) localStorage.setItem('monopoly_avatar', avatar);
  if (typeof soundOn === 'boolean') {
    Sound.enabled = soundOn;
    localStorage.setItem('monopoly_sound', soundOn ? 'on' : 'off');
  }
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
          <li>结算时可「💾 导出对局记录」</li>
          <li>切到别的标签页时，标签标题会提示是否轮到你；顶部「📋 总览」可查看全局资产表</li>
          <li>「🏗 建设」「🏦 抵押」按钮会弹出选择列表，不用再满地图找格子</li>
        </ul>
        <p><strong>⏱ 回合上限</strong></p>
        <ul style="margin-left:18px; margin-bottom:10px;">
          <li>房主开局前可设 30/50/80 回合上限，防止拖 endless 局</li>
          <li>两张地图可选：<b>经典版</b> / <b>中国城市版</b>（北京、上海当深蓝地王）</li>
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
});

socket.on('disconnect', () => {
  if (state.view === 'game') toast('⚠️ 连接断开，正在重连…', 'error');
});

socket.on('joined', ({ roomId, token, spectator }) => {
  if (token && !token.startsWith('bot_')) state.myToken = token;
  if (spectator) toast('游戏已开始，你以观战身份进入', 'info');
  showView('game');
  socket.emit('getStats', { name: localStorage.getItem('monopoly_name') || '' });
  if (!localStorage.getItem('monopoly_seen_help')) {
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
      <span class="lr-id">🏠 ${escapeHtml(r.id)}</span>
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
  if (els.myStatsLine) {
    els.myStatsLine.innerHTML = mine
      ? `📊 我的战绩（${escapeHtml(mine.name)}）：${mine.wins} 胜 / ${mine.games} 局${mine.bestNet ? ' · 巅峰净资产 ¥' + mine.bestNet.toLocaleString() : ''}`
      : '';
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
    return `<span class="gchip" style="background:${playerColor(pid)};color:#fff;">${escapeHtml(p.name)}${p.bankrupt ? ' 💀' : ''}</span>`;
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
       <button class="btn btn-secondary" onclick="answerProposal(${pr.seq}, false)">❌ 不卖</button>`
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
       <p style="font-size:12px;color:var(--text-tertiary);">30 秒内不回应将自动取消</p>`,
      `<button class="btn btn-primary" onclick="answerTrade(${t.seq}, true)">✅ 接受</button>
       <button class="btn btn-secondary" onclick="answerTrade(${t.seq}, false)">❌ 拒绝</button>`
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
    els.auctionPanel.classList.add('hidden');
    state.lastTickSecond = null;
    return;
  }
  const cell = state.game.board[a.cellId];
  if (!cell) { els.auctionPanel.classList.add('hidden'); return; }

  els.auctionPanel.classList.remove('hidden');
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
    if (cell.type === 'city' && meta) rentTxt = `租金：空地 ¥${meta.rents[0].toLocaleString()} → 🏨 ¥${meta.rents[5].toLocaleString()}（每级建造 ¥${meta.houseCost.toLocaleString()}）`;
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
