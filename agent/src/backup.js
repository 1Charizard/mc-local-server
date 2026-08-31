// 备份管理: 打包 worlds -> R2 (S3 兼容 API) + 列表 + 回滚
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

class Backup {
  constructor(bdsCfg, r2Cfg, backupCfg, bds, rcon) {
    this.bdsCfg = bdsCfg;
    this.r2Cfg = r2Cfg;
    this.cfg = backupCfg || {};
    this.bds = bds;
    this.rcon = rcon;
    this.client = new S3Client({
      region: 'auto',
      endpoint: r2Cfg.endpoint,
      credentials: { accessKeyId: r2Cfg.accessKeyId, secretAccessKey: r2Cfg.secretAccessKey },
    });
    this.bucket = r2Cfg.bucket;
    this.prefix = 'backups/';
  }

  /** 创建备份: save hold -> tar.gz -> 上传 R2 -> save resume */
  async create(name = 'manual') {
    const bdsDir = this.bdsCfg.dir;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupId = `${this.prefix}${name}_${ts}.tar.gz`;
    const tmpFile = `/tmp/mc1life_backup_${Date.now()}.tar.gz`;

    // 1. 让 BDS 暂停存档写入 (若在运行)
    let saveHeld = false;
    try {
      const rc = this.rcon;
      await rc.exec('save hold');
      await rc.exec('save query'); // 等待保存完成
      saveHeld = true;
    } catch { /* RCON 不可用时跳过 */ }

    try {
      // 2. 打包 (tar 排除临时/日志)
      const includes = this.cfg.includeDirs || ['worlds'];
      const args = ['-czf', tmpFile, ...includes];
      // 排除 large DB 临时文件
      args.push('--exclude=*.tmp', '--exclude=session.lock');
      await execFileP('tar', args, { cwd: bdsDir, maxBuffer: 64 * 1024 * 1024 });

      // 3. 上传 R2 (分片)
      const fileStream = fs.createReadStream(tmpFile);
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: backupId,
          Body: fileStream,
          ContentType: 'application/gzip',
        },
        partSize: 10 * 1024 * 1024,
      });
      await upload.done();
      const size = fs.statSync(tmpFile).size;

      // 4. 轮转: 只保留最近 N 份
      await this._rotate();

      return { backupId, size, ts, ok: true };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (saveHeld) { try { await this.rcon.exec('save resume'); } catch {} }
    }
  }

  async _rotate() {
    const keep = this.cfg.keep || 5;
    const list = await this.list();
    const autos = list.filter(b => b.name === 'auto').sort((a, b) => b.ts - a.ts);
    for (const b of autos.slice(keep)) {
      try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: b.backupId })); } catch {}
    }
  }

  async list() {
    const out = [];
    let token;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token,
      }));
      for (const o of res.Contents || []) {
        const m = o.Key.match(/backups\/(.+)_(\d{4}-\d{2}-\d{2}T[\d-]+)\.tar\.gz$/);
        out.push({
          backupId: o.Key,
          name: m ? m[1] : 'unknown',
          ts: m ? m[2] : o.LastModified,
          size: o.Size,
          lastModified: o.LastModified,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : null;
    } while (token);
    return out.sort((a, b) => (b.ts > a.ts ? 1 : -1));
  }

  /** 回滚: 下载备份 -> 停服 -> 解压覆盖 -> 重启 */
  async restore(backupId) {
    const bds = this.bds;
    const tmpFile = `/tmp/mc1life_restore_${Date.now()}.tar.gz`;

    // 1. 下载
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: backupId }));
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpFile);
      res.Body.pipe(ws);
      res.Body.on('error', reject);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    // 2. 停服
    const wasRunning = bds.running;
    if (wasRunning) await bds.stop();

    try {
      // 3. 备份当前世界 (防误操作)
      const curDir = path.join(this.bdsCfg.dir, 'worlds');
      const preRollback = `${curDir}.prerollback_${Date.now()}`;
      if (fs.existsSync(curDir)) {
        await execFileP('mv', [curDir, preRollback]);
      }
      // 4. 解压
      await execFileP('mkdir', ['-p', curDir]);
      await execFileP('tar', ['-xzf', tmpFile, '-C', this.bdsCfg.dir]);
      // 5. 清理预回滚目录
      await execFileP('rm', ['-rf', preRollback]).catch(() => {});
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    // 6. 重启
    if (wasRunning) await bds.start();
    return { restored: backupId, ok: true };
  }
}

module.exports = Backup;
