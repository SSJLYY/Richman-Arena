# -*- coding: utf-8 -*-
# v2.10 smoke test patch
src = open('smoke-test.js', encoding='utf-8').read().replace('\r\n', '\n')

# 1) 主实例：按 token 精确踢机器人（插在"移除最后一个机器人（恢复3人）"之后）
old = "  check('移除最后一个机器人（恢复3人）', A.state.order.length === 3);"
assert old in src, 'kick anchor'
src = src.replace(old, """  check('移除最后一个机器人（恢复3人）', A.state.order.length === 3);

  // ── v2.10：按 token 精确移除 ──
  const easyBotId = A.state.order.find(id => A.state.players[id] && A.state.players[id].botLevel === 'easy');
  A.socket.emit('addBot', { difficulty: 'hard' });
  await sleep(400);
  check('困难机器人加入（4人）', A.state.order.length === 4);
  A.socket.emit('kickBot', { token: easyBotId });
  await sleep(400);
  check('按 token 精确移除 easy bot', A.state.order.length === 3 && !A.state.order.includes(easyBotId) && A.state.order.some(id => A.state.players[id].botLevel === 'hard'));
  A.socket.emit('kickBot');
  await sleep(400);
  check('移除困难机器人（恢复3人）', A.state.order.length === 3);""")

# 2) ROOM2：带建筑地产不可交易（插在 v2.6 抽卡测试之前、提案测试之后）
old = "  // ── v2.6：抽卡事件 ──"
assert old in src, 'v2.6 anchor'
src = src.replace(old, """  // ── v2.10：带建筑地产不可交易 ──
  T.socket.emit('testHook', { op: 'setLevel', cellId: 3, n: 1 });
  await sleep(300);
  T.socket.emit('trade', { targetId: 'tok_t2____2', giveMoney: 0, getMoney: 0, giveProps: [3], getProps: [] });
  await sleep(400);
  check('带建筑地产交易被拒绝', T.state.board[3].owner === 'tok_t1____1');
  check('建筑仍在（level=1）', T.state.board[3].level === 1);
  T.socket.emit('testHook', { op: 'setLevel', cellId: 3, n: 0 });
  await sleep(250);
  T.socket.emit('trade', { targetId: 'tok_t2____2', giveMoney: 0, getMoney: 0, giveProps: [3], getProps: [] });
  await sleep(400);
  check('无建筑可正常交易（对照）', T.state.board[3].owner === 'tok_t2____2');

  // ── v2.6：抽卡事件 ──""")

open('smoke-test.js', 'w', encoding='utf-8').write(src)
print('smoke v2.10 ok')
