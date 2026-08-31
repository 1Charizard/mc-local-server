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
