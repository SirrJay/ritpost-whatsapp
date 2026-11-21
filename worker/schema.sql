-- RitPost AI server database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Premium access codes you hand out.
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 300,
  max_devices INTEGER NOT NULL DEFAULT 3,
  expires_at INTEGER,                -- ms since epoch, NULL = never
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  total_uses INTEGER NOT NULL DEFAULT 0
);

-- Which RitPost installs use a code (for the device limit).
CREATE TABLE IF NOT EXISTS code_devices (
  code TEXT NOT NULL,
  install_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (code, install_id)
);

-- Daily counters: subject = 'i:<install>' | 'c:<code>' | 'ip:<hash>' | 'all' | 'free' | 'premium' | 'adminfail:<hash>'
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
);

-- Recent requests (kept 90 days).
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  tier TEXT NOT NULL,
  code TEXT,
  install_id TEXT,
  ip_hash TEXT,
  model TEXT,
  platform TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS requests_day ON requests (day);
CREATE INDEX IF NOT EXISTS requests_at ON requests (at);

-- Blocked installs or IPs: subject = 'i:<install>' | 'ip:<hash>'
CREATE TABLE IF NOT EXISTS blocks (
  subject TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
