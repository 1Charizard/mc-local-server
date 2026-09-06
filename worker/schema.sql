-- MC1life D1 数据库 schema
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL DEFAULT 'unknown',
  action TEXT NOT NULL,
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  payload TEXT DEFAULT '{}',
  result TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

INSERT OR IGNORE INTO settings (key, value) VALUES ('motd', 'MC1life 服务器');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_interval_min', '360');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_keep', '5');

-- 心跳状态 (高频写, KV 免费写配额 1000/天不够 → 迁 D1)
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  ts INTEGER NOT NULL
);
-- Agent 日志 (保留最近 500 行)
CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent_id, id);

-- 上传/导出分片暂存 (KV 免费写配额不够, R2 未启用 → D1 单表; 分片 base64 需 <1MB)
CREATE TABLE IF NOT EXISTS staging (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  sub TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (kind, id, sub)
);
CREATE INDEX IF NOT EXISTS idx_staging_kind_id ON staging(kind, id);
