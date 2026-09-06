// 本地 console 通道冒烟测试 + 并发串行 + 无输出命令
const BDS = require('../src/bds');
const path = require('path');
const mockDir = __dirname;

(async () => {
  const b = new BDS(
    { dir: mockDir, runScript: path.join(mockDir, 'mock_bds_console.sh'), startTimeoutMs: 20000 },
    { rcon: null }
  );
  const t0 = Date.now();
  await b.start();
  console.log(`STARTED in ${Date.now() - t0}ms`);

  // 1) 有输出命令
  const r1 = await b.exec('list', 8000);
  console.log('LIST_RESULT:', JSON.stringify(r1));
  if (!/There are 2\/10 players online: Steve, Alex/.test(String(r1))) {
    throw new Error('list 响应解析不符合预期');
  }

  // 2) 并发串行
  const [c1, c2] = await Promise.all([b.exec('list', 8000), b.exec('list', 8000)]);
  console.log('CONC_OK:', /players online/.test(String(c1)) && /players online/.test(String(c2)));

  // 3) 无输出命令 (say) — 应在 ~3s 内成功返回空
  const t1 = Date.now();
  const r3 = await b.exec('say hello', 10000);
  console.log('SAY_RESULT:', JSON.stringify(r3), 'in', Date.now() - t1, 'ms');
  if (Date.now() - t1 > 8000) throw new Error('say 无输出命令超时');

  // 4) 未知命令 (有 ERROR 输出)
  const r4 = await b.exec('version', 8000);
  console.log('VERSION_RESULT:', JSON.stringify(r4));
  if (!/Unknown command/.test(String(r4))) throw new Error('未知命令应返回 ERROR');

  // 5) 停止
  await b.stop();
  console.log('STOPPED OK');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
