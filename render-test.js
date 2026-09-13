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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
