/* Test runner: spawns server, runs e2e, cleans up */
const { spawn, execSync } = require('child_process');
const path = require('path');

const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8091', MONOPOLY_DATA_DIR: path.join(__dirname, '.e2e_data_' + Date.now()) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stdout.write('[srv] ' + d));
server.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));

function cleanup(code) {
  try { server.kill(); } catch (e) {}
  process.exit(code);
}

setTimeout(() => {
  const { io } = require('socket.io-client');
  const URL = 'http://127.0.0.1:8091';
  const ROOM = 'test-room-e2e';
  const results = [];
  function check(name, cond, extra = '') {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  }
  const connect = () => new Promise(res => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
  const waitFor = (s, ev, t = 5000) => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout waiting ' + ev)), t);
    s.once(ev, d => { clearTimeout(to); res(d); });
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  (async () => {
    const a = await connect();
    const stateA = {};
    a.on('state', st => Object.assign(stateA, st));
    a.on('msg', m => console.log('  [msg]', m));

    a.emit('join', { roomId: ROOM, name: '测试玩家A', token: 'uaaaaaaaaaa' });
    await waitFor(a, 'joined');
    await sleep(300);
    check('加入房间', stateA.players && Object.keys(stateA.players).length === 1);
    check('房主设置正确', stateA.hostToken === 'uaaaaaaaaaa');

    a.emit('addBot'); await sleep(300);
    a.emit('addBot'); await sleep(300);
    check('添加2个机器人', stateA.order.length === 3);
    check('机器人加入', stateA.order.filter(t => stateA.players[t].isBot).length === 2);

    const b = await connect();
    const stateB = {};
    b.on('state', st => Object.assign(stateB, st));
    b.emit('join', { roomId: ROOM, name: '测试玩家B', token: 'ubbbbbbbbbb' });
    await waitFor(b, 'joined');
    await sleep(200);
    b.emit('addBot'); await sleep(300);
    check('非房主不能加机器人', stateB.order.filter(t => stateB.players[t] && stateB.players[t].isBot).length === 2);

    a.emit('start');
    await sleep(400);
    check('游戏开始', stateA.started === true);

    await sleep(4000);
    check('真人未行动时回合停住', stateA.order[stateA.turnIndex] === 'uaaaaaaaaaa');

    const myTurn = stateA.order[stateA.turnIndex] === 'uaaaaaaaaaa';
    if (myTurn) {
      a.emit('roll');
      await sleep(1600);
      // 掷出双数会获得额外回合（未进入决策阶段），继续掷直到决策阶段或换人
      for (let i = 0; i < 4 && stateA.started && !stateA.ended &&
           stateA.order[stateA.turnIndex] === 'uaaaaaaaaaa' && !stateA.currentRolled; i++) {
        a.emit('roll');
        await sleep(1600);
      }
      // 决策阶段：结束回合交棒，机器人才能行动
      if (stateA.currentRolled && stateA.order[stateA.turnIndex] === 'uaaaaaaaaaa') {
        a.emit('endTurn');
        await sleep(600);
      }
      await sleep(6000); // give bots time to act after player's turn
      check('玩家掷骰后状态更新', stateA.dice && stateA.dice.length === 2);
      check('玩家掷骰日志', stateA.logs.some(l => l.text.includes('测试玩家A 掷出')));
      const botRolls = stateA.logs.filter(l => l.text.includes('机器人') && l.text.includes('掷出'));
      check('机器人自动掷骰', botRolls.length >= 1, `${botRolls.length} 次机器人掷骰`);
      const botBuys = stateA.logs.filter(l => l.text.includes('机器人') && l.text.includes('购买'));
      console.log(`  [info] 机器人购房次数: ${botBuys.length}`);
    } else {
      console.log('SKIP 玩家掷骰（当前不是玩家A回合）');
      await sleep(4000);
    }

    a.disconnect();
    await sleep(500);
    const a2 = await connect();
    let stateRe = null;
    a2.on('state', st => { stateRe = st; });
    a2.emit('join', { roomId: ROOM, name: '测试玩家A', token: 'uaaaaaaaaaa' });
    await waitFor(a2, 'joined');
    await sleep(400);
    check('断线重连身份保持', stateRe && stateRe.players['uaaaaaaaaaa'] !== undefined);
    check('重连后仍保留席位', stateRe && stateRe.order.includes('uaaaaaaaaaa'));
    check('重连标记 connected', stateRe && stateRe.players['uaaaaaaaaaa'].connected === true);

    a2.emit('addBot'); await sleep(300);
    check('游戏开始后不能加机器人', stateRe && stateRe.order.length === 4);

    a2.emit('chat', '大家好！');
    await sleep(300);
    check('聊天消息广播', stateRe && stateRe.chats.some(c => c.text === '大家好！'));

    const http = require('http');
    const health = await new Promise(res => {
      http.get(URL + '/health', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    });
    check('健康检查接口', health.status === 'ok');

    // board data integrity check
    check('棋盘数据完整(40格)', stateRe && stateRe.board.length === 40);
    check('pos字段格式正确', stateRe && stateRe.board[0].pos && typeof stateRe.board[0].pos.r === 'number');

    const passed = results.filter(r => r.pass).length;
    console.log(`\n===== 结果: ${passed}/${results.length} 通过 =====`);
    [a2, b].forEach(s => s.disconnect());
    setTimeout(() => cleanup(passed === results.length ? 0 : 1), 300);
  })().catch(e => { console.error('TEST ERROR:', e.message); cleanup(2); });
}, 1500);