# -*- coding: utf-8 -*-
# v2.13.1 test fix: random test port, guaranteed cleanup, remove probes
src = open('smoke-test.js', encoding='utf-8').read().replace('\r\n', '\n')

# 1) 随机测试端口
old = """  const DATA_DIR2 = '/tmp/mono_test_' + Date.now();
  const spawnTestServer = () => spawn('node', ['server.js'], {
    env: { ...process.env, MONOPOLY_TEST: '1', PORT: '8090', MONOPOLY_DATA_DIR: DATA_DIR2 },
    stdio: 'ignore',
  });
  const proc = spawnTestServer();
  await sleep(1200);"""
assert old in src, 'spawn anchor'
src = src.replace(old, """  const DATA_DIR2 = '/tmp/mono_test_' + Date.now();
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
  await sleep(1200);""")

# 2) 所有 8090 引用改为动态 URL
src = src.replace("client('http://127.0.0.1:8090', 'T1')", "client(URL2, 'T1')")
src = src.replace("client('http://127.0.0.1:8090', 'T2')", "client(URL2, 'T2')")
src = src.replace("io('http://127.0.0.1:8090', { transports: ['websocket'] })", "io(URL2, { transports: ['websocket'] })")

# 3) 移除调试探针
old = """  T.socket.emit('testHook', { op: 'setMoney', amount: 999 });
  await sleep(300);
  console.log('  [dbg] T1 money after setMoney(999):', T.state.players['tok_t1____1'].money, '| T1 bankrupt:', T.state.players['tok_t1____1'].bankrupt, '| T1 connected:', T.socket.connected);
  // T2 踩 T1 的地中海大道（1级房）→ 租金 500；重试 + T1 踩商人bot的cell3 作双通道兜底"""
assert old in src, 'probe anchor'
src = src.replace(old, """  // T2 踩 T1 的地中海大道（1级房）→ 租金 500；重试 + T1 踩商人bot的cell3 作双通道兜底""")

old = """  const mrOk = T.state.maxRent && T.state.maxRent.amount > 0 && !!T.state.maxRent.cell;
  if (!mrOk) {
    console.log('  [debug] maxRent =', JSON.stringify(T.state.maxRent), '| T1 pos =', T.state.players['tok_t1____1'].pos, '| T2 pos =', T.state.players['tok_t2____2'].pos);
    console.log('  [debug] logs:', JSON.stringify(T.state.logs.slice(-10).map(l => l.text)));
  }
  check('最大单笔租金记录', mrOk);"""
assert old in src, 'debug dump anchor'
src = src.replace(old, """  const mrOk = T.state.maxRent && T.state.maxRent.amount > 0 && !!T.state.maxRent.cell;
  check('最大单笔租金记录', mrOk);""")

# 4) 兜底清理：正常结束与异常路径都 SIGKILL
old = """  console.log('\\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });"""
assert old in src, 'tail anchor'
src = src.replace(old, """  cleanupProcs();
  console.log('\\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  try { cleanupProcs && cleanupProcs(); } catch (e2) {}
  console.error('测试异常:', e);
  process.exit(1);
  });""".replace('  });', '});'))

open('smoke-test.js', 'w', encoding='utf-8').write(src)
print('test hardened')
