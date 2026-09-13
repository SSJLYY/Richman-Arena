# -*- coding: utf-8 -*-
# v2.27 patch: game replay (per-round board snapshots + timeline slider)
BS = chr(92)

# ========== SERVER ==========
src = open('server.js', encoding='utf-8').read().replace('\r\n', '\n')

# ── 1. createRoom：回放快照数组 ──
old = """    landingStats: {},      // 掷骰到访次数 {cellId: count}"""
assert old in src, 'room anchor'
src = src.replace(old, """    landingStats: {},      // 掷骰到访次数 {cellId: count}
    replay: [],            // 每轮棋盘快照（对局回放用）""")

# ── 2. 快照助手 + 开局存第一帧 + 每轮包裹存帧 ──
old = """    if (room.settings.randomFirst) {"""
assert old in src, 'start rf anchor'
src = src.replace(old, """    pushReplaySnapshot(room);
    if (room.settings.randomFirst) {""")

old = """    room.nwHistory.push(snap);
    if (room.nwHistory.length > 200) room.nwHistory.shift();
    checkRoundLimit(room);"""
assert old in src, 'wrap anchor'
src = src.replace(old, """    room.nwHistory.push(snap);
    if (room.nwHistory.length > 200) room.nwHistory.shift();
    pushReplaySnapshot(room);
    checkRoundLimit(room);""")

# 快照助手（放 playerNetWorth 之前）
old = "function playerNetWorth(room, playerId) {"
assert old in src, 'networth anchor'
src = src.replace(old, """// 每轮棋盘快照（对局回放）：紧凑数组 + 该帧日志长度
function pushReplaySnapshot(room) {
  const cells = room.board.map(c => [c.owner || 0, c.level || 0, c.mortgaged ? 1 : 0]);
  const players = {};
  room.order.forEach(id => {
    const p = room.players[id];
    if (!p) return;
    players[id] = [p.pos, p.money, p.bankrupt ? 1 : 0];
  });
  room.replay.push({ r: room.roundCount, c: cells, p: players, lg: room.logs.length });
  if (room.replay.length > 80) room.replay.shift();
}

function playerNetWorth(room, playerId) {""")

# ── 3. getPublicState / 持久化 ──
old = """    landingStats: room.landingStats,"""
assert old in src, 'state anchor'
src = src.replace(old, """    landingStats: room.landingStats,
    replay: room.replay,""")

old = "landingStats: r.landingStats || {}, startedAt: r.startedAt || null, rentMul: r.rentMul || 1, houseMul: r.houseMul || 1,"
assert old in src, 'save anchor'
src = src.replace(old, "landingStats: r.landingStats || {}, startedAt: r.startedAt || null, rentMul: r.rentMul || 1, houseMul: r.houseMul || 1, replay: r.replay || [],")
old = """      room.startedAt = s.startedAt || null;"""
assert old in src, 'load anchor'
src = src.replace(old, """      room.startedAt = s.startedAt || null;
      room.replay = Array.isArray(s.replay) ? s.replay : [];""")

# ── 4. 版本 ──
old = "🎲 大富翁在线 v2.26 服务器已启动"
assert old in src, 'version anchor'
src = src.replace(old, "🎲 大富翁在线 v2.27 服务器已启动")

open('server.js', 'w', encoding='utf-8').write(src)
print('server v2.27 ok')

# ========== FRONTEND ==========
app = open('public/app.js', encoding='utf-8').read().replace('\r\n', '\n')

# ── 1. state：回放模式 ──
old = """  lastTickSecond: null, // 拍卖倒计时已滴答的秒数"""
assert old in app, 'state anchor'
app = app.replace(old, """  lastTickSecond: null, // 拍卖倒计时已滴答的秒数
  replayIdx: null,      // 回放模式：当前查看的快照下标（null = 直播）""")

# ── 2. els：回放按钮 ──
old = """  overviewBtn: $('overviewBtn'),"""
assert old in app, 'els anchor'
app = app.replace(old, """  overviewBtn: $('overviewBtn'),
  replayBtn: $('replayBtn'),""")

# ── 3. displayGame()：直播或回放视图数据 ──
old = """function fmtElapsed(from) {"""
assert old in app, 'fmtElapsed anchor'
app = app.replace(old, """// 回放模式下返回由快照重建的"视图态"，否则返回直播态
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

function fmtElapsed(from) {""")

# ── 4. render 系列改走 displayGame ──
old = """function renderBoard() {
  if (!state.game) return;"""
assert old in app, 'renderBoard anchor'
app = app.replace(old, """function renderBoard() {
  const g = displayGame();
  if (!state.game) return;""", 1)

# renderBoard 内部的 state.game 引用替换为 g（谨慎：只替换函数体内常见字段）
old = """  state.game.board.forEach(cell => {"""
assert old in app, 'rb board anchor'
app = app.replace(old, """  g.board.forEach(cell => {""", 1)

# renderPlayers 头部改走 displayGame
old = """function renderPlayers() {
  if (!state.game) return;
  els.playersList.innerHTML = '';
  state.game.order.forEach(pid => {
    const p = state.game.players[pid];
    if (!p) return;"""
assert old in app, 'renderPlayers anchor'
app = app.replace(old, """function renderPlayers() {
  if (!state.game) return;
  const rg = displayGame();
  els.playersList.innerHTML = '';
  rg.order.forEach(pid => {
    const p = rg.players[pid];
    if (!p) return;""")

# ── 5. 回放横幅 + 退出按钮（棋盘上方提示条）──
old = """  els.inviteBtn.style.display = state.game ? '' : 'none';"""
assert old in app, 'render display anchor'
app = app.replace(old, """  els.inviteBtn.style.display = state.game ? '' : 'none';
  els.replayBtn.style.display = (state.game && state.game.started && (state.game.replay || []).length >= 2) ? '' : 'none';""")

# ── 6. 回放按钮事件 + 打开回放模式 ──
old = """  els.overviewBtn?.addEventListener('click', () => openAssetsOverview());"""
assert old in app, 'listener anchor'
app = app.replace(old, """  els.overviewBtn?.addEventListener('click', () => openAssetsOverview());
  els.replayBtn?.addEventListener('click', () => openReplay());""")

# openReplay + 滑杆 UI（插在 openNwChart 之前）
old = """// ────────────────────────────────────────────────────────────
// 净资产趋势图
// ────────────────────────────────────────────────────────────"""
assert old in app, 'chart anchor'
app = app.replace(old, """// ────────────────────────────────────────────────────────────
// 对局回放（滑杆逐轮查看棋盘快照）
// ────────────────────────────────────────────────────────────
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
  banner.innerHTML = `
    <span>🎥 对局回放 · 第 <b id="rpRound">${snaps[state.replayIdx].r}</b> 轮 / 共 ${snaps.length} 帧</span>
    <input type="range" id="rpSlider" min="0" max="${snaps.length - 1}" value="${state.replayIdx}" style="flex:1;" />
    <button class="btn btn-sm btn-secondary" id="rpExit">退出回放</button>`;
  const section = document.querySelector('.board-section');
  if (section) section.insertBefore(banner, section.firstChild);
  const slider = document.getElementById('rpSlider');
  slider.addEventListener('input', () => {
    state.replayIdx = Number(slider.value);
    const snap = snaps[state.replayIdx];
    document.getElementById('rpRound').textContent = snap.r;
    render();
  });
  document.getElementById('rpExit').addEventListener('click', exitReplay);
}

function exitReplay() {
  state.replayIdx = null;
  const b = document.getElementById('replayBanner');
  if (b) b.remove();
  render();
}

window.exitReplay = exitReplay;

// ────────────────────────────────────────────────────────────
// 净资产趋势图
// ────────────────────────────────────────────────────────────""")

# 中央面板：回放模式提示（覆盖轮次行）
old = """    ${g.startedAt ? ' · 已用 ' + fmtElapsed(g.startedAt) : ''}</div>`"""
assert old in app, 'bc-round elapsed anchor'
app = app.replace(old, """    ${g.startedAt ? ' · 已用 ' + fmtElapsed(g.startedAt) : ''}${state.replayIdx !== null ? ' · 🎥 回放中' : ''}</div>`""")

# ── 7. 结算弹窗加回放入口 ──
old = """    `<button class="btn btn-secondary" onclick="exportGameLog()">💾 导出对局记录</button>"""
assert old in app, 'victory footer anchor'
app = app.replace(old, """    `<button class="btn btn-secondary" onclick="openReplay()">🎥 回放本局</button>
     <button class="btn btn-secondary" onclick="exportGameLog()">💾 导出对局记录</button>""")

# ── 8. 帮助补充 ──
old = """          <li>结算时可「💾 导出对局记录」</li>"""
assert old in app, 'help anchor'
app = app.replace(old, """          <li>结算时可「💾 导出对局记录」；顶部「🎥 回放」可逐轮回看棋盘演变</li>""")

open('public/app.js', 'w', encoding='utf-8').write(app)

# HTML：头部回放按钮
html = open('public/index.html', encoding='utf-8').read().replace('\r\n', '\n')
old = """            <button class="btn btn-sm btn-ghost" id="overviewBtn" title="地产总览" style="display:none;">📋 总览</button>"""
assert old in html, 'html anchor'
html = html.replace(old, """            <button class="btn btn-sm btn-ghost" id="overviewBtn" title="地产总览" style="display:none;">📋 总览</button>
            <button class="btn btn-sm btn-ghost" id="replayBtn" title="逐轮回看棋盘" style="display:none;">🎥 回放</button>""")
open('public/index.html', 'w', encoding='utf-8').write(html)

# CSS
css = open('public/style.css', encoding='utf-8').read()
css += """

/* v2.27: replay banner */
.replay-banner {
  display: flex; align-items: center; gap: 10px;
  background: linear-gradient(135deg, rgba(206, 147, 216, 0.18), rgba(79, 195, 247, 0.14));
  border: 1px solid var(--accent-info);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 10px;
  z-index: 5;
}
"""
open('public/style.css', 'w', encoding='utf-8').write(css)
print('v2.27 all ok')
