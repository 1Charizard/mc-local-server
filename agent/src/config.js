// 配置文件读写: server.properties / whitelist.json / permissions.json / banned-players.json / banned-ips.json
const fs = require('fs');
const path = require('path');

const JSON_FILES = ['whitelist.json', 'allowlist.json', 'permissions.json', 'banned-players.json', 'banned-ips.json'];

class Config {
  constructor(bdsCfg) {
    this.dir = bdsCfg.dir;
  }

  listFiles() {
    return [
      { file: 'server.properties', type: 'properties', editable: true },
      ...JSON_FILES.map(f => ({ file: f, type: 'json', editable: fs.existsSync(path.join(this.dir, f)) })),
    ];
  }

  async getAll(file = 'server.properties') {
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) throw new Error(`文件不存在: ${file}`);
    const raw = fs.readFileSync(full, 'utf8');
    if (file === 'server.properties' || file.endsWith('.properties')) {
      const map = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
      return { file, type: 'properties', data: map };
    }
    return { file, type: 'json', data: JSON.parse(raw || '[]') };
  }

  async set(file, key, value, { restart = false } = {}) {
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) throw new Error(`文件不存在: ${file}`);

    if (file === 'server.properties' || file.endsWith('.properties')) {
      let text = fs.readFileSync(full, 'utf8');
      const re = new RegExp(`^${key}=.*$`, 'm');
      const newLine = `${key}=${value}`;
      if (re.test(text)) text = text.replace(re, newLine);
      else text += (text.endsWith('\n') ? '' : '\n') + newLine;
      fs.writeFileSync(full, text, 'utf8');
    } else {
      let data;
      try { data = JSON.parse(fs.readFileSync(full, 'utf8') || '[]'); } catch { data = []; }
      // 简单键值型 JSON 文件直接读写 data[key]
      data[key] = value;
      fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
    }

    // 部分配置需重启生效 (server.properties 全部重启生效; JSON 白名单即时)
    const needsRestart = restart && (file === 'server.properties' || file.endsWith('.properties'));
    return { file, key, value, needsRestart };
  }

  async readProperties() {
    const full = path.join(this.dir, 'server.properties');
    const map = {};
    if (fs.existsSync(full)) {
      for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
    }
    return map;
  }
}

module.exports = Config;
