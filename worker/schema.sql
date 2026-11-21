-- RitPost server database (Cloudflare D1). The server also adds anything missing on its own.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Plans you sell (features = JSON: AI rewrites, devices, posting limits per platform...).
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  features TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Access codes you hand out (each one is on a plan).
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT -1,   -- AI rewrites per day; -1 = the plan's
  max_devices INTEGER NOT NULL DEFAULT -1,   -- -1 = the plan's
  expires_at INTEGER,                -- ms since epoch, NULL = never
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  total_uses INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'owner',  -- team member id, or 'owner'
  contact TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0             -- amount paid
);

-- Which RitPost installs use a code (for the device limit).
CREATE TABLE IF NOT EXISTS code_devices (
  code TEXT NOT NULL,
  install_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (code, install_id)
);

-- Daily counters: subject = 'i:<install>' | 'c:<code>' | 'ip:<hash>' | 'all' | 'free' | 'premium' (AI),
--   'p:<platform>:i:<install>' | 'p:<platform>:c:<code>' | 'posts' | 'posts:<platform>' (posting), 'adminfail:<hash>'
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

-- Posting requests from RitPost (kept 90 days).
CREATE TABLE IF NOT EXISTS post_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  tier TEXT NOT NULL,
  plan_id TEXT,
  code TEXT,
  install_id TEXT,
  ip_hash TEXT,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'claim',   -- claim | release
  status TEXT NOT NULL,                 -- ok | denied
  reason TEXT
);
CREATE INDEX IF NOT EXISTS post_log_day ON post_log (day);

-- Admin portal team.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,                   -- admin | sales | support | viewer
  pw TEXT,
  status TEXT NOT NULL DEFAULT 'invited', -- invited | active | disabled
  own_only INTEGER NOT NULL DEFAULT 0,  -- sees only the codes they created
  invite_hash TEXT,
  invite_exp INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT 'owner'
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
