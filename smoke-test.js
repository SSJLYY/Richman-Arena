/* v2.4 冒烟测试：主实例全流程回归 + 测试实例确定性验证（决策阶段/奖池/拍卖） */
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const URL = 'http://127.0.0.1:8081';
const ROOM = 'smoke_' + Date.now().toString(36);

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(url, name) {
  const s = io(url, { transports: ['websocket'] });
  const c = { socket: s, name, state: null };
  s.on('state', st => { c.state = st; });
  s.on('msg', m => console.log('  [msg→' + name + '] ' + m));
  return c;
}

(async () => {
  // ════════ 主实例：全流程回归 ════════
  const A = client(URL, 'Alice'), B = client(URL, 'Bob');
  A.socket.on('connect', () => A.socket.emit('join', { roomId: ROOM, name: 'Alice', token: 'tok_alice_1', avatar: '🧑' }));
  B.socket.on('connect', () => B.socket.emit('join', { roomId: ROOM, name: 'Bob', token: 'tok_bob___1', avatar: '👩' }));
  await sleep(800);

  check('两人加入房间', A.state && A.state.order.length === 2 && !A.state.started);

  A.socket.emit('addBot');
  await sleep(400);
  check('机器人加入（3人）', A.state.order.length === 3);

  // ── v2.6：机器人难度 ──
  A.socket.emit('addBot', { difficulty: 'easy' });
  await sleep(400);
  const easyBotId = A.state.order.find(id => A.state.players[id] && A.state.players[id].botLevel === 'easy');
  check('简单机器人加入（4人）', A.state.order.length === 4 && !!easyBotId);
  A.socket.emit('kickBot');
  await sleep(400);
  check('移除最后一个机器人（恢复3人）', A.state.order.length === 3);

  // ── v2.10：按 token 精确移除（踢普通bot，保留新加的 easy bot 继续游戏）──
  const botNormalId = A.state.order.find(id => A.state.players[id] && A.state.players[id].isBot);
  A.socket.emit('addBot', { difficulty: 'easy' });
  await sleep(400);
  check('第二个机器人加入（4人）', A.state.order.length === 4);
  A.socket.emit('kickBot', { token: botNormalId });
  await sleep(400);
  const easyBotId2 = A.state.order.find(id => A.state.players[id] && A.state.players[id].botLevel === 'easy');
  check('按 token 精确移除（普通bot删，easy留）', A.state.order.length === 3 && !A.state.order.includes(botNormalId) && !!easyBotId2);

  A.socket.emit('start');
  await sleep(400);
  check('游戏开始', A.state.started === true);
  check('回合数=1', A.state.roundCount === 1);
  check('turnStartedAt 存在', typeof A.state.turnStartedAt === 'number');
  check('turnTimeoutMs=120000', A.state.turnTimeoutMs === 120000);
  check('棋盘含 rent 字段', typeof A.state.board[1].rent === 'number');

  // Alice 掷骰
  A.socket.emit('roll');
  await sleep(1600);
  check('骰子已掷', Array.isArray(A.state.dice));
  check('决策阶段字段存在', typeof A.state.currentRolled === 'boolean');
  check('奖池字段存在', typeof A.state.jackpot === 'number');

  // 购买（若仍在决策阶段且可买）
  let st1 = A.state;
  let alice = st1.players[st1.order[0]];
  let cell = st1.board[alice.pos];
  let onBuyable = !cell.owner && cell.price > 0 && alice.money >= cell.price;
  if (st1.order[st1.turnIndex] === st1.order[0] && onBuyable) {
    A.socket.emit('buy');
    await sleep(400);
    const st2 = A.state;
    check('购买成功（所有权变更）', st2.board[alice.pos].owner === st1.order[0] && st2.players[st1.order[0]].money < alice.money);
    check('购买后该格 rent>0', st2.board[alice.pos].rent > 0 || st2.board[alice.pos].group === 'utility');
  } else {
    console.log('  ⏭ 未落在可购买格/非决策阶段，跳过购买断言');
  }

  // 轮转观察机器人自动行动
  let botMoved = false;
  for (let i = 0; i < 14 && !botMoved; i++) {
    const st = A.state;
    if (!st.started || st.ended) break;
    const curTok = st.order[st.turnIndex];
    if (st.players[curTok] && st.players[curTok].isBot) {
      await sleep(3500);
      botMoved = true;
      check('机器人自动行动（有日志）', A.state.logs.length > 3);
    } else if (curTok === 'tok_alice_1') {
      if (!st.currentRolled) { A.socket.emit('roll'); await sleep(1600); }
      else { A.socket.emit('endTurn'); await sleep(400); }
    } else if (curTok === 'tok_bob___1') {
      if (!st.currentRolled) { B.socket.emit('roll'); await sleep(1600); }
      else { B.socket.emit('endTurn'); await sleep(400); }
    } else {
      await sleep(500);
    }
  }
  check('机器人回合已执行', botMoved);

  // 非当前玩家掷骰应被拒
  const logsBefore = B.state.logs.length;
  B.socket.emit('roll');
  await sleep(600);
  check('非当前玩家掷骰被拒绝', B.state.logs.length <= logsBefore + 2);

  // 等机器人回合链（含双数连掷）完全结束，避免并发金钱变动干扰断言
  for (let i = 0; i < 20; i++) {
    const cur = A.state.order[A.state.turnIndex];
    const cp = A.state.players[cur];
    if (!cp || !cp.isBot) break;
    await sleep(800);
  }

  // 交易：提议 → 对方接受（v2.11 需双方确认）
  const aMoney = A.state.players['tok_alice_1'].money;
  A.socket.emit('trade', { targetId: 'tok_bob___1', giveMoney: 100, getMoney: 0, giveProps: [], getProps: [] });
  await sleep(500);
  check('交易提议创建（未立即执行）', A.state.trade && A.state.trade.to === 'tok_bob___1' && A.state.players['tok_alice_1'].money === aMoney);
  B.socket.emit('tradeResp', { seq: A.state.trade.seq, accept: true });
  await sleep(500);
  check('对方接受后转账生效', A.state.players['tok_alice_1'].money === aMoney - 100 && A.state.trade === null);
  check('租金收支字段就绪', typeof A.state.players['tok_alice_1'].rentEarned === 'number' && typeof A.state.players['tok_alice_1'].rentPaid === 'number');

  // 托管开/关
  A.socket.emit('toggleDelegation');
  await sleep(400);
  check('托管开启（delegated=true）', A.state.players['tok_alice_1'].delegated === true);
  A.socket.emit('toggleDelegation');
  await sleep(400);
  check('托管取消（delegated=false）', A.state.players['tok_alice_1'].delegated === false);

  // 退出 → 机器人接管 → 重连收回
  const bobMoneyBefore = A.state.players['tok_bob___1'].money;
  B.socket.emit('leave');
  await sleep(500);
  const bobP = A.state.players['tok_bob___1'];
  check('退出后机器人接管（isBot=true）', bobP && bobP.isBot === true);
  check('接管后保留原名记录（origName=Bob）', bobP && bobP.origName === 'Bob');
  check('接管后资产保留', bobP && bobP.money === bobMoneyBefore);
  B.socket.emit('join', { roomId: ROOM, name: 'Bob', token: 'tok_bob___1', avatar: '👩' });
  await sleep(500);
  const bobP2 = A.state.players['tok_bob___1'];
  check('重连收回控制权（isBot=false）', bobP2 && bobP2.isBot === false);
  check('重连后原名恢复', bobP2 && bobP2.origName === null && bobP2.name === 'Bob');

  // 重置
  A.socket.emit('reset');
  await sleep(500);
  check('房间重置（started=false）', A.state.started === false && A.state.order.length === 3);
  A.socket.close(); B.socket.close();
  await sleep(300);

  // ════════ 测试实例：确定性验证（决策阶段/奖池/拍卖）════════
  console.log('\n--- v2.4 测试实例（确定性）---');
  const DATA_DIR2 = '/tmp/mono_test_' + Date.now();
  const TEST_PORT = String(9000 + Math.floor(Math.random() * 800));
  const URL2 = 'http://127.0.0.1:' + TEST_PORT;
  const procs = [];
  const spawnTestServer = () => {
    const p = spawn('node', ['server.js'], {
      env: { ...process.env, MONOPOLY_TEST: '1', PORT: TEST_PORT, MONOPOLY_DATA_DIR: DATA_DIR2 },
      stdio: 'ignore',
    });
    procs.push(p);
    return p;
  };
  const cleanupProcs = () => { procs.forEach(p => { try { p.kill('SIGKILL'); } catch (e) {} }); };
  const proc = spawnTestServer();
  await sleep(1200);

  const ROOM2 = 't_' + Date.now().toString(36);
  const T = client(URL2, 'T1');
  const T2 = client(URL2, 'T2');
  T.socket.on('connect', () => T.socket.emit('join', { roomId: ROOM2, name: 'T1', token: 'tok_t1____1', avatar: '🧑' }));
  T2.socket.on('connect', () => T2.socket.emit('join', { roomId: ROOM2, name: 'T2', token: 'tok_t2____2', avatar: '👩' }));
  await sleep(700);
  // ── v2.9：房间设置（起始资金）──
  T.socket.emit('setSettings', { startMoney: 20000, map: 'china', turnTimeoutMs: 30000 });
  await sleep(300);
  check('房主设置起始资金 ¥20000', T.state.settings && T.state.settings.startMoney === 20000);
  check('回合限时设置生效（30秒）', T.state.settings.turnTimeoutMs === 30000 && T.state.turnTimeoutMs === 30000);
  // 立即恢复默认，避免 30 秒超时干扰后续长流程
  T.socket.emit('setSettings', { turnTimeoutMs: 120000 });
  await sleep(300);
  check('回合限时恢复（120秒）', T.state.settings.turnTimeoutMs === 120000);

  // ── v2.24：武林风云版（经济六折快速图）──
  T.socket.emit('setSettings', { map: 'wulin' });
  await sleep(300);
  check('武林风云版生效（cell1=丐帮，¥400）', T.state.mapId === 'wulin' && T.state.board[1].name === '丐帮' && T.state.board[1].price === 400);
  check('倍率下发（租金/建造 0.6）', T.state.rentMul === 0.6 && T.state.houseMul === 0.6);
  // 切回中国城市版，保证后续流程断言沿用原有数值
  T.socket.emit('setSettings', { map: 'china' });
  await sleep(300);
  check('切回中国城市版', T.state.mapId === 'china' && T.state.board[1].name === '兰州');
  check('中国城市版地图生效（cell1=兰州）', T.state.mapId === 'china' && T.state.board[1].name === '兰州' && T.state.board[39].name === '北京');
  check('两版地图结构一致（40格/组别数）', T.state.board.length === 40 && T.state.board.filter(c => c.group === 'brown').length === 2);
  check('默认开关：奖池开/拍卖开', T.state.settings.jackpotOn === true && T.state.settings.auctionOn === true);

  T.socket.emit('start');
  await sleep(400);
  check('起始资金生效（¥20000）', T.state.players['tok_t1____1'].money === 20000);
  check('初始净资产快照（r0）', Array.isArray(T.state.nwHistory) && T.state.nwHistory.length === 1);

  // 未掷骰 endTurn 必须被拒
  const ti0 = T.state.turnIndex;
  T.socket.emit('endTurn');
  await sleep(400);
  check('未掷骰 endTurn 被拒绝', T.state.turnIndex === ti0 && T.state.currentRolled === false);

  // 奖池：设置 → 停车场赢池 → 清零
  T.socket.emit('testHook', { op: 'jackpot', amount: 3000 });
  await sleep(300);
  check('奖池已设置（¥3000）', T.state.jackpot === 3000);
  const t1money0 = T.state.players['tok_t1____1'].money;
  T.socket.emit('testHook', { op: 'resolve', pos: 20 });
  await sleep(400);
  check('停车场赢走奖池 +¥3000', T.state.players['tok_t1____1'].money === t1money0 + 3000);
  check('奖池已清零', T.state.jackpot === 0);

  // 所得税入奖池
  T.socket.emit('testHook', { op: 'resolve', pos: 4 });
  await sleep(400);
  check('所得税 ¥2000 入奖池', T.state.jackpot === 2000);

  // 决策阶段
  check('落地后进入决策阶段（currentRolled=true）', T.state.currentRolled === true);
  check('决策阶段未交棒', T.state.order[T.state.turnIndex] === 'tok_t1____1');

  // 拍卖全流程
  T.socket.emit('testHook', { op: 'auction', cellId: 1 });
  await sleep(400);
  check('拍卖已开启', T.state.auction && T.state.auction.cellId === 1);
  const t1m = T.state.players['tok_t1____1'].money;
  const t2m = T.state.players['tok_t2____2'].money;
  T.socket.emit('auctionBid', { amount: 500 });
  await sleep(300);
  check('T1 出价 ¥500 生效', T.state.auction && T.state.auction.topBid === 500 && T.state.auction.topBidder === 'tok_t1____1');
  T2.socket.emit('auctionBid', { amount: 600 });
  await sleep(300);
  check('T2 加价 ¥600 生效', T.state.auction && T.state.auction.topBid === 600);
  check('拍卖出价记录留存', Array.isArray(T.state.auction.bids) && T.state.auction.bids.length >= 2);
  console.log('  ⏳ 等待拍卖结算（约 24 秒）…');
  await sleep(24000);
  check('拍卖结算：cell1 归 T2', T.state.board[1].owner === 'tok_t2____2');
  check('T2 扣款 ¥600', T.state.players['tok_t2____2'].money === t2m - 600);
  check('T1 未扣款', T.state.players['tok_t1____1'].money === t1m);
  check('拍卖已清空', T.state.auction === null);
  check('拍卖成交地块金光事件（cell1 ¥600）', T.state.lastRentPaid && T.state.lastRentPaid.cellId === 1 && T.state.lastRentPaid.amount === 600);

  // 低价/不足步进出价必须被拒（v2.18：起拍 ¥100，此后必须整步 +100）
  T.socket.emit('testHook', { op: 'auction', cellId: 3 });
  await sleep(300);
  T.socket.emit('auctionBid', { amount: 50 }); // 低于起拍 → 拒绝
  await sleep(250);
  const lowRejected = T.state.auction && T.state.auction.topBid === 0;
  T.socket.emit('auctionBid', { amount: 100 }); // 起拍价 → 成功
  await sleep(250);
  T.socket.emit('auctionBid', { amount: 150 }); // 不足整步 +100 → 拒绝
  await sleep(250);
  check('低价出价被拒绝', lowRejected && T.state.auction && T.state.auction.topBid === 100);
  await sleep(21000);

  // ── v2.5：筹钱期（欠款）──
  T.socket.emit('testHook', { op: 'setMoney', amount: 500 });
  await sleep(250);
  T.socket.emit('testHook', { op: 'resolve', pos: 4 });
  await sleep(400);
  const debt = T.state.debt;
  check('税款欠款触发筹钱期', debt && debt.amount === 2000 && debt.playerId === 'tok_t1____1');
  check('筹钱期内未破产', T.state.players['tok_t1____1'].bankrupt === false);
  const tiDebt = T.state.turnIndex;
  T.socket.emit('endTurn');
  await sleep(300);
  check('欠款未清 endTurn 被拒绝', T.state.turnIndex === tiDebt && T.state.debt !== null);
  T.socket.emit('testHook', { op: 'setMoney', amount: 3000 });
  await sleep(400);
  check('筹够后自动结算（3000-2000=1000）', T.state.debt === null && T.state.players['tok_t1____1'].money === 1000);
  check('补缴税款入奖池（2000+2000=4000）', T.state.jackpot === 4000);

  // ── v2.7：观战 / 聊天限速 ──
  const sSock = io(URL2, { transports: ['websocket'] });
  let seenRooms = null;
  sSock.on('roomList', l => { seenRooms = l; });
  sSock.on('connect', () => sSock.emit('join', { roomId: ROOM2, name: '观众S', token: 'tok_spec__1' }));
  await sleep(600);
  sSock.emit('getRooms');
  await sleep(400);
  const room2info = (seenRooms || []).find(r => r.id === ROOM2);
  check('观战者加入且计入观众数', room2info && room2info.spectators >= 1);
  sSock.emit('chat', '大家好');
  await sleep(400);
  const specChat = T.state.chats.find(c => c.text === '大家好');
  check('观战聊天名字正常（非 ?）', specChat && specChat.from !== '?');
  for (let i = 0; i < 6; i++) T.socket.emit('chat', '刷屏' + i);
  await sleep(400);
  const t1Chats = T.state.chats.filter(c => c.from === 'T1');
  check('聊天限速生效（10 秒最多 5 条）', t1Chats.length === 5);

  // ── v2.8：AI 购地提案（接受/拒绝）──
  T.socket.emit('testHook', { op: 'addBotForce' });
  await sleep(300);
  const botTok = T.state.order.find(id => T.state.players[id] && T.state.players[id].isBot);
  check('测试机器人注入（不参与行动）', !!botTok && T.state.players[botTok].bankrupt === true);
  const t2mBefore = T.state.players['tok_t2____2'].money;
  T2.socket.emit('testHook', { op: 'mkproposal', cellId: 1, amount: 2000 });
  await sleep(300);
  check('购地提案生成（cell1→T2）', T.state.proposal && T.state.proposal.cellId === 1 && T.state.proposal.to === 'tok_t2____2');
  T2.socket.emit('proposalResp', { seq: T.state.proposal.seq, accept: true });
  await sleep(400);
  check('接受后地产过户给机器人', T.state.board[1].owner === botTok);
  check('卖家收到全款 +¥2000', T.state.players['tok_t2____2'].money === t2mBefore + 2000);
  check('提案已清除', T.state.proposal === null);
  T.socket.emit('testHook', { op: 'mkproposal', cellId: 3, amount: 1000 });
  await sleep(300);
  check('第二个提案生成（cell3→T1）', T.state.proposal && T.state.proposal.cellId === 3 && T.state.proposal.to === 'tok_t1____1');
  if (T.state.proposal) {
    T.socket.emit('proposalResp', { seq: T.state.proposal.seq, accept: false });
  }
  await sleep(300);
  check('拒绝后地产保留且提案清除', T.state.board[3].owner === 'tok_t1____1' && T.state.proposal === null);

  // ── v2.10：带建筑地产不可交易 ──
  T.socket.emit('testHook', { op: 'setLevel', cellId: 3, n: 1 });
  await sleep(300);
  T.socket.emit('trade', { targetId: 'tok_t2____2', giveMoney: 0, getMoney: 0, giveProps: [3], getProps: [] });
  await sleep(400);
  check('带建筑地产交易被拒绝', T.state.board[3].owner === 'tok_t1____1');
  check('建筑仍在（level=1）', T.state.board[3].level === 1);
  T.socket.emit('testHook', { op: 'setLevel', cellId: 3, n: 0 });
  await sleep(250);
  T.socket.emit('trade', { targetId: 'tok_t2____2', giveMoney: 0, getMoney: 0, giveProps: [3], getProps: [] });
  await sleep(300);
  T2.socket.emit('tradeResp', { seq: T.state.trade.seq, accept: true });
  await sleep(400);
  check('无建筑可正常交易（对照）', T.state.board[3].owner === 'tok_t2____2');

  // ── v2.11：银行房源限制 ──
  check('银行房源暴露（32房/12酒店）', T.state.bank && T.state.bank.houses === 32 && T.state.bank.hotels === 12);
  T.socket.emit('testHook', { op: 'setOwner', cellId: 1 });
  T.socket.emit('testHook', { op: 'setOwner', cellId: 3 });
  await sleep(300);
  T.socket.emit('build', { cellId: 1, action: 'build' });
  await sleep(300);
  check('建造消耗银行房源（32→31）', T.state.bank.houses === 31 && T.state.board[1].level === 1);
  T.socket.emit('testHook', { op: 'setBank', n: 0 });
  await sleep(250);
  T.socket.emit('build', { cellId: 3, action: 'build' });
  await sleep(300);
  check('银行无房时建造被拒', T.state.board[3].level === 0 && T.state.bank.houses === 0);
  T.socket.emit('testHook', { op: 'setBank', n: 32 });
  await sleep(200);

  // ── v2.12：与机器人交易（估值接受/拒绝）──
  T.socket.emit('testHook', { op: 'addBotSide' });
  await sleep(300);
  const sideBot = Object.keys(T.state.players).find(id => id.startsWith('bot_side_'));
  check('侧车测试机器人注入', !!sideBot && T.state.players[sideBot].isBot === true);
  // 白送 cell3（价值600）→ bot 必然接受
  T.socket.emit('trade', { targetId: sideBot, giveMoney: 0, getMoney: 0, giveProps: [3], getProps: [] });
  await sleep(2600);
  check('bot 接受有利交易（cell3 过户）', T.state.board[3].owner === sideBot);
  check('bot 交易后 trade 清空', T.state.trade === null);
  // 索要 ¥5000 不给任何东西 → bot 拒绝
  const sideBotMoney = T.state.players[sideBot].money;
  T.socket.emit('trade', { targetId: sideBot, giveMoney: 0, getMoney: 5000, giveProps: [], getProps: [] });
  await sleep(2600);
  check('bot 拒绝亏本交易（资金不变）', T.state.players[sideBot].money === sideBotMoney && T.state.board[3].owner === sideBot);
  check('拒绝后 trade 清空', T.state.trade === null);

  // ── v2.13：最大单笔租金记录 ──
  // T1 拥有 cell1(level1)+cell3（棕色成套）；T2 踩 cell1 → 租金 500
  // T2 踩 T1 的地中海大道（1级房）→ 租金 500；重试 + T1 踩商人bot的cell3 作双通道兜底
  T2.socket.emit('testHook', { op: 'landAs', pos: 1 });
  await sleep(450);
  if (!(T.state.maxRent && T.state.maxRent.amount > 0)) {
    T2.socket.emit('testHook', { op: 'landAs', pos: 1 });
    await sleep(550);
  }
  if (!(T.state.maxRent && T.state.maxRent.amount > 0)) {
    T.socket.emit('testHook', { op: 'landAs', pos: 3 }); // T1 踩商人bot的波罗的海大道 → ¥40
    await sleep(550);
  }
  const mrOk = T.state.maxRent && T.state.maxRent.amount > 0 && !!T.state.maxRent.cell;
  check('最大单笔租金记录', mrOk);

  // ── v2.19：公用事业租金回归（锁 2.18 的 NaN 修复）──
  T.socket.emit('testHook', { op: 'setOwner', cellId: 12 });
  await sleep(300);
  const t1before = T.state.players['tok_t1____1'].money;
  T2.socket.emit('testHook', { op: 'landAs', pos: 12 });
  await sleep(450);
  const t1after = T.state.players['tok_t1____1'].money;
  const rentGot = t1after - t1before;
  check('公用事业租金正确（¥280，无NaN）', rentGot === 280 && Number.isFinite(rentGot));
  check('街道收益统计（cell12 累计 ¥280）', T.state.board[12].incomeEarned === 280);

  // ── v2.6：抽卡事件 ──
  T.socket.emit('testHook', { op: 'lastCard' });
  await sleep(300);
  check('抽卡事件暴露（lastCard）', T.state.lastCard && T.state.lastCard.text === 'TEST卡');

  // ── v2.6：回合上限（到时净资产定胜负）──
  T.socket.emit('testHook', { op: 'setMax', n: 1 });
  T.socket.emit('testHook', { op: 'setRounds', n: 1 });
  await sleep(300);
  check('回合上限已设置（1回合）', T.state.maxRounds === 1);
  T.socket.emit('endTurn'); // T1 交棒（欠款已清）
  await sleep(500);
  check('交棒到 T2（未到上限）', T.state.order[T.state.turnIndex] === 'tok_t2____2' && !T.state.ended);
  // T2 掷骰 + 结束（双数会额外行动，循环处理）
  for (let i = 0; i < 8; i++) {
    const st = T.state;
    if (st.ended || st.order[st.turnIndex] !== 'tok_t2____2') break;
    if (!st.currentRolled) { T2.socket.emit('roll'); await sleep(1700); }
    else { T2.socket.emit('endTurn'); await sleep(500); }
  }
  check('到达回合上限游戏结束', T.state.ended === true);
  check('净资产最高者获胜（T2）', T.state.winnerToken === 'tok_t2____2');
  const winLog = T.state.logs.map(l => l.text).join('|');
  check('结束原因标注回合上限', winLog.includes('回合上限'));
  check('净资产历史已记录（≥2 轮）', Array.isArray(T.state.nwHistory) && T.state.nwHistory.length >= 2);
  check('落地热度已记录（≥1 格）', T.state.landingStats && Object.keys(T.state.landingStats).length >= 1);

  // ── v2.5：服务器重启房间恢复 ──
  const jackpotAtEnd = T.state.jackpot; // T2 掷骰可能踩税入池，动态快照
  T.socket.emit('testHook', { op: 'save' });
  await sleep(400);
  proc.kill();
  await sleep(600);
  const proc2 = spawnTestServer();
  await sleep(1400);
  const T3 = client(URL2, 'T1-re');
  T3.socket.on('connect', () => T3.socket.emit('join', { roomId: ROOM2, name: 'T1', token: 'tok_t1____1', avatar: '🧑' }));
  await sleep(800);
  check('重启后房间恢复（started=true）', T3.state && T3.state.started === true);
  check('重启后玩家席位保留', T3.state && T3.state.order.includes('tok_t1____1'));
  check('重启后地产归属保留（cell1→T1, cell3→商人bot）', T3.state && T3.state.board[1].owner === 'tok_t1____1' && T3.state.board[3].owner === sideBot);
  check('重启后奖池保留', T3.state && T3.state.jackpot === jackpotAtEnd);
  check('重启后结束状态与胜者保留', T3.state && T3.state.ended === true && T3.state.winnerToken === 'tok_t2____2');
  check('重启后净资产历史保留', T3.state && Array.isArray(T3.state.nwHistory) && T3.state.nwHistory.length >= 2);
  check('重启后落地热度保留', T3.state && T3.state.landingStats && Object.keys(T3.state.landingStats).length >= 1);
  check('重启后房间设置保留', T3.state && T3.state.settings && T3.state.settings.startMoney === 20000);
  T.socket.close(); T2.socket.close(); T3.socket.close();
  sSock.close();
  proc2.kill();
  await sleep(300);

  cleanupProcs();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { if (typeof cleanupProcs === 'function') cleanupProcs(); console.error('测试异常:', e); process.exit(1); });
