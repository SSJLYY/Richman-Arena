/* 压力测试：多房间 × 多玩家 × 随机操作风暴
 * 用法：node load-test.js [总客户端数=40] [持续秒数=30]
 * 退出码 0 = 通过（服务存活、延迟达标、无内存爆涨）
 */
const { io } = require('socket.io-client');
const { spawn } = require('child_process');

const TOTAL_CLIENTS = Number(process.argv[2]) || 40;
const DURATION_SEC = Number(process.argv[3]) || 30;
const PORT = process.env.LOAD_PORT || '8096';
const URL = 'http://127.0.0.1:' + PORT;

const proc = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, MONOPOLY_TEST: '1', PORT, MONOPOLY_DATA_DIR: '/tmp/mono_load_' + Date.now() },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let srvErr = '';
proc.stderr.on('data', d => { srvErr += d; if (srvErr.length > 4000) srvErr = srvErr.slice(-2000); });
proc.on('exit', (c) => { console.log(`[!!] 服务器进程退出 code=${c}`); process.exitCode = 2; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = [];
let ops = 0, joins = 0, errs = 0;

function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

(async () => {
  await sleep(1200);
  const t0 = Date.now();

  // 建立 N 个客户端，分散到 ~TOTAL/4 个房间
  const roomCount = Math.max(2, Math.floor(TOTAL_CLIENTS / 4));
  for (let i = 0; i < TOTAL_CLIENTS; i++) {
    const s = io(URL, { transports: ['websocket'], reconnection: true });
    const roomId = 'load_' + (i % roomCount);
    const token = 'ld_' + i + '_' + Math.random().toString(36).slice(2, 6);
    const c = { s, roomId, token, name: '负载' + i, lastState: null, isHost: false };
    s.on('state', st => { c.lastState = st; });
    s.on('connect', () => {
      joins++;
      s.emit('join', { roomId, name: c.name, token, avatar: '🧑' });
      if (c.lastState === null || !c.lastState.started) {
        // 尝试开局（仅第一个进房者会成功，其余收到 msg 忽略）
        setTimeout(() => s.emit('start'), rand(50, 200));
        s.emit('addBot', { difficulty: 'normal' });
        s.emit('addBot', { difficulty: 'hard' });
      }
    });
    s.on('connect_error', () => errs++);
    clients.push(c);
  }
  console.log(`[load] ${TOTAL_CLIENTS} 客户端已发起，房间数 ${roomCount}`);

  // 风暴阶段：随机操作
  const storm = setInterval(() => {
    clients.forEach(c => {
      if (!c.s.connected || Math.random() < 0.5) return;
      ops++;
      const r = Math.random();
      if (r < 0.4) c.s.emit('roll');
      else if (r < 0.55) c.s.emit('endTurn');
      else if (r < 0.7) c.s.emit('chat', '压测消息 ' + rand(1, 99));
      else if (r < 0.8) c.s.emit('auctionBid', { amount: rand(100, 2000) });
      else if (r < 0.9) c.s.emit('setAutoBuy', { on: Math.random() < 0.5 });
      else c.s.emit('getRooms');
    });
  }, 500);

  await sleep(DURATION_SEC * 1000);
  clearInterval(storm);

  // 服务健康测量（连续 3 次取最差）
  const http = require('http');
  const get = (path) => new Promise(res => {
    const t = Date.now();
    http.get(URL + path, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ ms: Date.now() - t, body: JSON.parse(d) })); })
      .on('error', e => res({ ms: 99999, body: null, err: e.message }));
  });
  const h1 = await get('/health');
  await sleep(300);
  const h2 = await get('/stats');
  await sleep(300);
  const h3 = await get('/health');
  const maxLatency = Math.max(h1.ms, h2.ms, h3.ms);

  let passed = 0, failed = 0;
  const check = (name, cond) => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
  check('服务器在风暴中存活', h1.body && h1.body.status === 'ok');
  check('健康检查延迟 < 500ms（实测 ' + maxLatency + 'ms）', maxLatency < 500);
  check('无客户端连接错误', errs === 0);
  check('全部客户端完成加入（' + joins + '/' + TOTAL_CLIENTS + '）', joins >= TOTAL_CLIENTS);
  check('风暴操作量 > 100（实测 ' + ops + '）', ops > 100);
  check('内存 < 300MB（实测 ' + (h2.body ? h2.body.heapMB : '?') + 'MB）', h2.body && h2.body.heapMB < 300);
  check('服务器无崩溃日志', !/Error|Exception/.test(srvErr));

  console.log(`\n===== 压测结果: ${passed}/${passed + failed} 通过 | 操作 ${ops} | 加入 ${joins} | 延迟 max ${maxLatency}ms =====`);
  clients.forEach(c => { try { c.s.close(); } catch (e) {} });
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} process.exit(failed > 0 ? 1 : 0); }, 400);
})().catch(e => { console.error('LOAD-TEST ERROR:', e.message); try { proc.kill('SIGKILL'); } catch (e2) {} process.exit(2); });
