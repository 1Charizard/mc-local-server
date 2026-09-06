// 世界导入结构测试: 覆盖单文件夹/夹带垃圾/深嵌套/根即内容/无效包
const Worlds = require('../src/worlds');
const path = require('path');
const fs = require('fs');

const FIX = path.join(__dirname, 'fixtures');
const OUT = '/tmp/mc1life_import_test_worlds';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const w = new Worlds({ dir: '/tmp/x', worldDir: OUT }, null);

async function t(zip, name, expectName) {
  const f = path.join(FIX, zip);
  const r = await w.importLocal(f, name);
  const world = r.world;
  const dir = path.join(OUT, world);
  const ok = fs.existsSync(path.join(dir, 'level.dat')) && fs.existsSync(path.join(dir, 'db'));
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${zip} -> world=${JSON.stringify(world)} expect=${JSON.stringify(expectName)} level.dat=${ok}`);
  if (!ok || (expectName && !String(world).startsWith(expectName))) throw new Error(`用例失败: ${zip} -> ${world}`);
}

(async () => {
  // A: 单文件夹, 机器名 -> levelname.txt "极限 (2)"
  await t('A_single_folder.zip', '4VL+bsRNWCs=', '极限 (2)');
  // B: 带 __MACOSX/.DS_Store
  await t('B_folder_with_junk.zip', '4VL+bsRNWCs=', '极限 (2)');
  // C: 深嵌套 (levelname.txt="WorldFolder")
  await t('C_deep_nested.zip', '4VL+bsRNWCs=', 'WorldFolder');
  // D: 根即内容 + 显式名
  await t('D_root_content.zip', '我的地图', '我的地图');
  // E: 无效包应报错
  let err = '';
  try { await t('E_no_leveldat.zip', 'x', null); } catch (e) { err = e.message; }
  if (!/未找到 level.dat/.test(err)) throw new Error('E 应报"未找到 level.dat", 实际: ' + err);
  console.log('[PASS] E_no_leveldat 正确拒绝:', err);

  // 防 zip-slip: 构造含 ../ 的 zip 应被拒绝
  const evilZip = path.join(FIX, 'F_evil_path.zip');
  fs.rmSync(evilZip, { force: true });
  const zlib = require('zlib');
  function makeZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameB = Buffer.from(name);
      const cdata = zlib.deflateRawSync(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(0, 14); lh.writeUInt32LE(cdata.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
      chunks.push(lh, nameB, cdata);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(0, 16); cd.writeUInt32LE(cdata.length, 20); cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameB.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, nameB);
      offset += lh.length + nameB.length + cdata.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
  }
  fs.writeFileSync(evilZip, makeZip([{ name: '../../evil.txt', data: Buffer.from('pwned') }]));
  err = '';
  try { await w.importLocal(evilZip, 'evil'); } catch (e) { err = e.message; }
  if (!/非法路径|路径逃逸/.test(err)) throw new Error('zip-slip 应被拒绝, 实际: ' + err);
  console.log('[PASS] zip-slip 路径穿越被拒绝:', err);
  if (fs.existsSync('/tmp/evil.txt')) throw new Error('危险: evil.txt 被写出!');

  console.log('ALL IMPORT TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
