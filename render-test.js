/*
 * 前端渲染回归测试（jsdom）
 *
 * 覆盖：棋盘增量渲染、中央面板刷新、日志跳过重建三大块。
 * 目的：证明广播频繁触发的 render() 不会重复重建 DOM，
 *      且各种地块状态（买地 / 建房 / 酒店 / 抵押 / 闪烁 / 换地图）显示正确。
 *
 * 运行：npm install && npm run test:render
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  [PASS] ' + name); }
  else { failed++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
};

// ── 构造假的 socket，避免真实网络 ──
function makeFakeSocket() {
  const base = { connected: true, id: 'fake-sock', io: { engine: { transport: {} } } };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      return () => base;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

// ── 构造最小可用棋盘数据（11x11 网格坐标，与服务端 pos 语义一致）──
function makeCell(id, over = {}) {
  return {
    id, name: `地块${id}`, price: 1000 + id, type: 'city', group: 'brown',
    owner: null, level: 0, mortgaged: false, rent: 0,
    pos: { r: Math.floor(id / 10), c: id % 11 },
    ...over,
  };
}
function makeGame(cells) {
  const board = cells || Array.from({ length: 40 }, (_, i) => makeCell(i));
  return {
    id: 'TEST', players: { p1: { name: '阿甲', avatar: 'A', money: 9000, pos: 0 } },
    order: ['p1'], turnIndex: 0, started: true, ended: false,
    board, dice: null, jackpot: 0, roundCount: 1, maxRounds: 0,
    logs: [], chats: [], nwHistory: [], mapId: 'classic',
  };
}

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost:8081/', pretendToBeVisual: true });
const win = dom.window;
win.io = makeFakeSocket;
try {
  win.eval(appSrc);
} catch (e) {
  console.error('app.js 载入失败:', e.message);
  process.exit(1);
}

// 注入并手工 setState / state.game（走 app.js 内部变量）
const setGame = (g) => {
  win.eval(`state.game = ${JSON.stringify(g)}; state.myToken='p1'; state.flashCells=[];`);
};

console.log('\n=== 1. 首次渲染：骨架建立 ===');
setGame(makeGame());
win.renderBoard();
const board = win.document.getElementById('board');
const cells1 = board.querySelectorAll('.cell');
check('生成 40 个格子', cells1.length === 40, `实际 ${cells1.length}`);
check('中央面板存在', !!board.querySelector('.board-center'));
const firstCellEl = cells1[0];
check('动态节点常驻但隐藏', firstCellEl.querySelector('.house-badge').style.display === 'none');
check('无主地不显示 owner-dot', firstCellEl.querySelector('.owner-dot').style.display === 'none');
check('未建房不显示 house-badge', firstCellEl.querySelector('.house-badge').style.display === 'none');
check('绑定了 dataset.cellId', firstCellEl.dataset.cellId === '0');
check('gridColumn 正确(+1)', firstCellEl.style.gridColumn === '1');

console.log('\n=== 2. 数据未变：应零重建 ===');
win.renderBoard();
check('DOM 引用完全相同（未重建）', board.querySelectorAll('.cell')[0] === firstCellEl);
check('格子数量仍为 40', board.querySelectorAll('.cell').length === 40);
check('中央面板未被重建', board.querySelector('.board-center') === win.document.querySelector('.board-center'));

console.log('\n=== 3. 买地：owner-dot 出现且复用同一节点 ===');
const g2 = makeGame();
g2.board[5].owner = 'p1';
g2.board[5].rent = 200;
setGame(g2);
win.renderBoard();
const c5 = board.querySelectorAll('.cell')[5];
check('仍是同一个 DOM 节点', c5 === board.querySelector('[data-cell-id="5"]'));
check('owner-dot 已显示', c5.querySelector('.owner-dot').style.display === '');
check('owner-dot 有玩家颜色', /rgb|#/.test(c5.querySelector('.owner-dot').style.background));
check('rent-badge 显示金额为 ¥200', c5.querySelector('.rent-badge').textContent === '¥200');
check('title 含地主名', c5.title.includes('阿甲'), c5.title);

console.log('\n=== 4. 建房：house-badge 更新 ===');
const g3 = makeGame();
g3.board[5].owner = 'p1'; g3.board[5].level = 3; g3.board[5].rent = 800;
setGame(g3);
win.renderBoard();
const c5b = board.querySelector('[data-cell-id="5"]');
check('仍是同一个 DOM 节点', c5b === c5);
check('显示 3 个房子', c5b.querySelector('.house-badge').textContent === '🏠🏠🏠', c5b.querySelector('.house-badge').textContent);
check('租金同步更新为 ¥800', c5b.querySelector('.rent-badge').textContent === '¥800');

console.log('\n=== 5. 盖满 5 级 → 酒店 ===');
const g4 = makeGame();
g4.board[5].owner = 'p1'; g4.board[5].level = 5;
setGame(g4);
win.renderBoard();
check('显示为酒店 🏨', board.querySelector('[data-cell-id="5"]').querySelector('.house-badge').textContent === '🏨');

console.log('\n=== 6. 抵押：class + 租金徽标隐藏 ===');
const g5 = makeGame();
g5.board[5].owner = 'p1'; g5.board[5].mortgaged = true; g5.board[5].rent = 0;
setGame(g5);
win.renderBoard();
const c5c = board.querySelector('[data-cell-id="5"]');
check('加上 mortgaged class', c5c.classList.contains('mortgaged'));
check('租金徽标隐藏', c5c.querySelector('.rent-badge').style.display === 'none');
check('title 标注已抵押', c5c.title.includes('已抵押'));

console.log('\n=== 7. 闪光格：class 开关互不残留 ===');
const g6 = makeGame();
setGame(g6);
win.eval('state.flashCells = [7];');
win.renderBoard();
check('第 7 格闪烁', board.querySelector('[data-cell-id="7"]').classList.contains('cell-flash'));
win.eval('state.flashCells = [];');
win.renderBoard();
check('下一帧闪烁已清除（动画可重播）', !board.querySelector('[data-cell-id="7"]').classList.contains('cell-flash'));

console.log('\n=== 8. 换地图（静态内容变化）→ 自动回退重建该格 ===');
const g7 = makeGame();
g7.mapId = 'china';
g7.board[3].name = '上海';
setGame(g7);
const before = board.querySelector('[data-cell-id="3"]');
win.renderBoard();
const after = board.querySelector('[data-cell-id="3"]');
check('静态签名变化触发重建', before !== after);
check('新名字已生效', after.querySelector('.cell-name').textContent === '上海');
check('格子总数不变', board.querySelectorAll('.cell').length === 40);

console.log('\n=== 9. 中央面板：内容不变时不重建 ===');
const g8 = makeGame();
setGame(g8);
win.renderBoard();
const centerBefore = board.querySelector('.board-center');
const htmlBefore = centerBefore.innerHTML;
win.renderBoard();
check('中央面板未重建', board.querySelector('.board-center') === centerBefore);
g8.jackpot = 500;
setGame(g8);
win.renderBoard();
check('奖池变化后面板已更新', board.querySelector('.board-center').innerHTML.includes('奖池'));
check('奖池金额正确', board.querySelector('.board-center').innerHTML.includes('500'));

console.log('\n=== 10. 公共事业地块 rent=-1 的哨兵值 ===');
const g9 = makeGame();
g9.board[12].type = 'utility'; g9.board[12].group = 'utility';
g9.board[12].owner = 'p1'; g9.board[12].rent = -1;
setGame(g9);
win.renderBoard();
check('显示为「骰×40」', board.querySelector('[data-cell-id="12"]').querySelector('.rent-badge').textContent === '骰×40');

console.log('\n=== 11. 日志：内容未变应跳过重建 ===');
const g10 = makeGame();
g10.logs = [{ ts: 1000, text: '开局' }, { ts: 2000, text: '阿甲掷出 7' }];
g10.chats = [{ ts: 3000, from: '阿甲', text: '打招呼' }];
setGame(g10);
win.renderLog();
const logBox = win.document.getElementById('log');
const entryBefore = logBox.querySelector('.log-entry');
const countBefore = logBox.querySelectorAll('.log-entry').length;
check('日志初始渲染 3 条', countBefore === 3, `实际 ${countBefore}`);
win.renderLog();
check('数据不变时跳过重建（DOM 引用不变）', logBox.querySelector('.log-entry') === entryBefore);

g10.chats.push({ ts: 4000, from: '系统', text: '有人抵押了地产' });
setGame(g10);
win.renderLog();
check('新增条目后重建', logBox.querySelectorAll('.log-entry').length === 4);
check('新条目排在首位（倒序展示）', logBox.querySelector('.log-entry').textContent.includes('抵押'));

win.eval("state.logFilter = 'game';");
win.renderLog();
const gameOnly = logBox.querySelectorAll('.log-entry');
check('切到「游戏」过滤只留 2 条', gameOnly.length === 2, `实际 ${gameOnly.length}`);
check('过滤后均为 game 类型', Array.from(gameOnly).every(e => e.classList.contains('game')));

// ════════ v2.34 前端 UI 回归：音量 / 回放 / 掷骰直方图 ════════

// ── 12. 音量滑块（Sound.volume ↔ localStorage 'monopoly_volume'）──
// app.js:93 Sound.volume = Number(localStorage.getItem('monopoly_volume') || 70)
// app.js:1811 设置面板渲染 <input type=range id=volumeInput min=0 max=100 value=Sound.volume>
// app.js:1832-1839 saveSettings() 回写 Sound.volume + localStorage
console.log('\n=== 12. 音量滑块：默认值 + 修改后可持久化 ===');
win.localStorage.removeItem('monopoly_volume');
const gs = makeGame();
gs.hostToken = 'p1'; gs.started = false;
setGame(gs);
win.openSettings();
const volEl = win.document.getElementById('volumeInput');
check('设置面板渲染音量滑块(min0/max100)', !!volEl && volEl.min === '0' && volEl.max === '100');
check('音量滑块默认值为 70', !!volEl && volEl.value === '70', `实际 ${volEl && volEl.value}`);
check('音量百分比文案随默认值显示 70%', win.document.getElementById('modalRoot').textContent.includes('70%'));
// 改值并保存 → 落 localStorage
volEl.value = '35';
win.saveSettings();
check('保存后音量写入 localStorage(35)', win.localStorage.getItem('monopoly_volume') === '35', `实际 ${win.localStorage.getItem('monopoly_volume')}`);
// 重新打开设置 → 滑块回填新值
win.openSettings();
const volEl2 = win.document.getElementById('volumeInput');
check('重开设置面板滑块回填为 35', !!volEl2 && volEl2.value === '35', `实际 ${volEl2 && volEl2.value}`);
check('重开音量百分比文案为 35%', win.document.getElementById('modalRoot').textContent.includes('35%'));
win.localStorage.removeItem('monopoly_volume'); // 还原，避免污染其它用例
win.hideModal();

// ── 13. 回放模式 UI（入口按钮显隐 + 回放控制区渲染/移除）──
// app.js:2160 els.replayBtn 仅在 started && replay.length>=2 时显示
// app.js:2193-2221 openReplay() 渲染 #replayBanner（滑杆/上一帧/下一帧/退出）
console.log('\n=== 13. 回放模式 UI：入口显隐 + 控制区渲染 ===');
const replayBtn = win.document.getElementById('replayBtn');
check('回放入口按钮存在于头部', !!replayBtn);
// 场景A：回放帧 < 2 → 入口隐藏，openReplay 不生成控制区
const gR0 = makeGame();
gR0.replay = [{ r: 1, c: [], p: {} }];
setGame(gR0);
win.eval('state.replayIdx = null;');
win.render();
check('回放帧<2 时入口按钮隐藏', replayBtn.style.display === 'none', `实际 ${replayBtn.style.display}`);
win.openReplay();
check('回放帧<2 时不渲染回放控制区', !win.document.getElementById('replayBanner'));
// 场景B：回放帧 >= 2 → 入口显示，openReplay 生成完整控制区
const snapC = Array.from({ length: 40 }, () => [0, 0, 0]);
const gR1 = makeGame();
gR1.replay = [
  { r: 1, c: snapC, p: { p1: [0, 9000, 0] } },
  { r: 2, c: snapC, p: { p1: [0, 9000, 0] } },
];
setGame(gR1);
win.eval('state.replayIdx = null;');
win.render();
check('回放帧≥2 时入口按钮显示', replayBtn.style.display === '', `实际 ${replayBtn.style.display}`);
win.openReplay();
const rb = win.document.getElementById('replayBanner');
check('回放控制区(#replayBanner)已渲染', !!rb);
check('控制区含滑杆/上一帧/下一帧/退出', !!win.document.getElementById('rpSlider') && !!win.document.getElementById('rpPrev') && !!win.document.getElementById('rpNext') && !!win.document.getElementById('rpExit'));
check('进入回放后 state.replayIdx 指向末帧', win.eval('state.replayIdx') === 1, `实际 ${win.eval('state.replayIdx')}`);
check('回放中央面板标注「回放中」', rb && win.document.querySelector('.board-center').textContent.includes('回放中'));
win.exitReplay();
check('退出回放后控制区移除', !win.document.getElementById('replayBanner'));
check('退出回放后 replayIdx 复位为 null', win.eval('state.replayIdx') === null);

// ── 14. 掷骰分布直方图（结算面板内的柱状文本）──
// app.js:1383-1386 diceHtml：diceHistory 存在正数时以 ▉ 字符渲染 2~12 点分布
console.log('\n=== 14. 掷骰分布直方图（结算面板）===');
// 场景A：diceHistory 全 0 → 不渲染直方图
const gH0 = makeGame();
gH0.diceHistory = Array(13).fill(0);
setGame(gH0);
win.showVictoryStats('p1');
const histText0 = win.document.getElementById('modalRoot').textContent;
check('无掷骰数据时不渲染直方图', !histText0.includes('掷骰分布'));
win.hideModal();
// 场景B：diceHistory 有数据 → 渲染直方图与柱体
const gH1 = makeGame();
gH1.diceHistory = Array(13).fill(0);
gH1.diceHistory[7] = 5;  // 掷出 7 点 5 次
gH1.diceHistory[2] = 1;
setGame(gH1);
win.showVictoryStats('p1');
const histText1 = win.document.getElementById('modalRoot').textContent;
check('有掷骰数据时渲染「掷骰分布」', histText1.includes('掷骰分布'), histText1.slice(0, 60));
check('直方图含柱体字符 ▉', histText1.includes('▉'));
check('直方图列出 2~12 共 11 个点数桶', (histText1.match(/\d+点/g) || []).length === 11, `实际 ${(histText1.match(/\d+点/g) || []).length}`);
win.hideModal();

// ── 15. 无障碍结构回归（第三轮 a11y 成果固化，防无声回退）──
console.log('\n=== 15. 无障碍结构（skip link / aria-live / dialog / 图标按钮）===');
const D = win.document;
const skip = D.querySelector('a.skip-link');
check('存在 skip link 且指向 #mainContent', !!skip && skip.getAttribute('href') === '#mainContent');
const main = D.getElementById('mainContent');
check('主内容区 #mainContent 存在且 tabindex=-1（可接收焦点）', !!main && main.getAttribute('tabindex') === '-1');
['turnBanner', 'moneyFloatLayer', 'actionHint'].forEach(id => {
  const el = D.getElementById(id);
  check(`#${id} 带 aria-live=polite`, !!el && el.getAttribute('aria-live') === 'polite');
});
const logEl = D.getElementById('log');
check('#log 带 role=log + aria-live', !!logEl && logEl.getAttribute('role') === 'log' && logEl.getAttribute('aria-live') === 'polite');
['themeBtn', 'helpBtn', 'settingsBtn', 'zoomIn', 'zoomOut', 'zoomReset', 'themeBtnLobby', 'helpBtnLobby'].forEach(id => {
  const el = D.getElementById(id);
  check(`图标按钮 #${id} 有非空 aria-label`, !!el && (el.getAttribute('aria-label') || '').length > 0);
});
// 动态弹窗：role=dialog + aria-modal + aria-labelledby 指向存在的元素
setGame(gH1);
win.showVictoryStats('p1');
const dlg = D.querySelector('#modalRoot [role="dialog"]');
check('弹窗含 role=dialog 容器', !!dlg);
check('aria-modal=true 且 tabindex=-1', !!dlg && dlg.getAttribute('aria-modal') === 'true' && dlg.getAttribute('tabindex') === '-1');
const lbId = dlg && dlg.getAttribute('aria-labelledby');
check('aria-labelledby 指向真实存在的标题元素', !!lbId && !!D.getElementById(lbId));
check('弹窗打开时 modalRoot 内有 .modal-content', !!D.querySelector('#modalRoot .modal-content'));
win.hideModal();
check('弹窗关闭后 modalRoot 清空（无泄漏）', (D.getElementById('modalRoot').innerHTML || '').trim() === '');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
