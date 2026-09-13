# -*- coding: utf-8 -*-
# v2.27 frontend patch — FINAL (all anchors verified against current code)
app = open('public/app.js', encoding='utf-8').read().replace('\r\n', '\n')

# 1) state
old = "  lastTickSecond: null,"
assert old in app, 'state'
app = app.replace(old, "  lastTickSecond: null,\n  replayIdx: null,      // 回放模式：当前查看的快照下标（null = 直播）", 1)

# 2) els
old = "  overviewBtn: $('overviewBtn'),"
assert old in app, 'els'
app = app.replace(old, "  overviewBtn: $('overviewBtn'),\n  replayBtn: $('replayBtn'),")

# 3) displayGame（插在 fmtElapsed 前）
old = "function fmtElapsed(from) {"
assert old in app, 'displayGame'
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

function fmtElapsed(from) {""", 1)

# 4) renderBoard 走 displayGame
old = "function renderBoard() {\n  if (!state.game) return;"
assert old in app, 'renderBoard'
app = app.replace(old, "function renderBoard() {\n  const g = displayGame();\n  if (!state.game) return;", 1)
old = "  state.game.board.forEach(cell => {"
assert old in app, 'board forEach'
app = app.replace(old, "  g.board.forEach(cell => {", 1)

# 5) renderPlayers 走 displayGame
old = """function renderPlayers() {
  if (!state.game) return;
  els.playersList.innerHTML = '';
  const ordered = [...state.game.order].sort((a, b) => {
    const pa = state.game.players[a], pb = state.game.players[b];
    return (pa && pa.bankrupt ? 1 : 0) - (pb && pb.bankrupt ? 1 : 0);
  });"""
assert old in app, 'renderPlayers'
app = app.replace(old, """function renderPlayers() {
  if (!state.game) return;
  const rg = displayGame();
  els.playersList.innerHTML = '';
  const ordered = [...rg.order].sort((a, b) => {
    const pa = rg.players[a], pb = rg.players[b];
    return (pa && pa.bankrupt ? 1 : 0) - (pb && pb.bankrupt ? 1 : 0);
  });""")
old = """  ordered.forEach(pid => {
    const p = state.game.players[pid];
    if (!p) return;
    const isCurrentTurn = state.game.order[state.game.turnIndex] === pid && state.game.started && !state.game.ended;"""
assert old in app, 'players iter'
app = app.replace(old, """  ordered.forEach(pid => {
    const p = rg.players[pid];
    if (!p) return;
    const isCurrentTurn = rg.order[rg.turnIndex] === pid && rg.started && !rg.ended;""")

# 6) 回放按钮显隐
old = "  els.inviteBtn.style.display = state.game ? '' : 'none';"
assert old in app, 'invite'
app = app.replace(old, "  els.inviteBtn.style.display = state.game ? '' : 'none';\n  els.replayBtn.style.display = (state.game && state.game.started && (state.game.replay || []).length >= 2) ? '' : 'none';")

# 7) 事件
old = "els.overviewBtn?.addEventListener('click', () => openAssetsOverview());"
assert old in app, 'listener'
app = app.replace(old, "els.overviewBtn?.addEventListener('click', () => openAssetsOverview());\n  els.replayBtn?.addEventListener('click', () => openReplay());")

# 8) openReplay + exitReplay（插在 净资产趋势图 注释前）
old = "// 净资产趋势图"
assert old in app, 'chart'
app = app.replace(old, """// 对局回放（滑杆逐轮查看棋盘快照）
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
    document.getElementById('rpRound').textContent = snaps[state.replayIdx].r;
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

// 净资产趋势图""", 1)

# 9) 中央面板回放提示（当前行使用 state.game.startedAt）
old = "${state.game.startedAt ? ' · 已用 ' + fmtElapsed(state.game.startedAt) : ''}</div>"
assert old in app, 'bc elapsed'
app = app.replace(old, "${state.game.startedAt ? ' · 已用 ' + fmtElapsed(state.game.startedAt) : ''}${state.replayIdx !== null ? ' · 🎥 回放中' : ''}</div>`")

# 10) 结算回放入口
old = "<button class=\"btn btn-secondary\" onclick=\"exportGameLog()\">💾 导出对局记录</button>"
assert old in app, 'export'
app = app.replace(old, "<button class=\"btn btn-secondary\" onclick=\"openReplay()\">🎥 回放本局</button>\n     " + old)

# 11) 帮助
old = "结算时可「💾 导出对局记录」"
assert old in app, 'help'
app = app.replace(old, "结算时可「💾 导出对局记录」；顶部「🎥 回放」可逐轮回看棋盘演变", 1)

open('public/app.js', 'w', encoding='utf-8').write(app)

html = open('public/index.html', encoding='utf-8').read().replace('\r\n', '\n')
old = "<button class=\"btn btn-sm btn-ghost\" id=\"overviewBtn\" title=\"地产总览\" style=\"display:none;\">📋 总览</button>"
assert old in html, 'html'
html = html.replace(old, "<button class=\"btn btn-sm btn-ghost\" id=\"overviewBtn\" title=\"地产总览\" style=\"display:none;\">📋 总览</button>\n            <button class=\"btn btn-sm btn-ghost\" id=\"replayBtn\" title=\"逐轮回看棋盘\" style=\"display:none;\">🎥 回放</button>")
open('public/index.html', 'w', encoding='utf-8').write(html)

css = open('public/style.css', encoding='utf-8').read()
css += "\n\n/* v2.27: replay banner */\n.replay-banner {\n  display: flex; align-items: center; gap: 10px;\n  background: linear-gradient(135deg, rgba(206, 147, 216, 0.18), rgba(79, 195, 247, 0.14));\n  border: 1px solid var(--accent-info);\n  border-radius: var(--radius-sm);\n  padding: 8px 12px;\n  font-size: 13px;\n  color: var(--text-primary);\n  margin-bottom: 10px;\n  z-index: 5;\n}\n"
open('public/style.css', 'w', encoding='utf-8').write(css)
print('frontend v2.27 ok')
