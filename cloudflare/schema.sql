-- Shiftly Report — Cloudflare D1 (SQLite) schema. Safe to re-run (idempotent).
-- Chạy: npx wrangler d1 execute shiftly --remote --file=schema.sql
-- Tương đương supabase/schema.sql; quyền truy cập được Worker (src/worker.js)
-- kiểm tra ở mỗi request thay cho SECURITY DEFINER + RLS.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                       -- giữ nguyên user_id cũ của Supabase khi nhập
  email TEXT COLLATE NOCASE,
  username TEXT COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user','supervisor')),
  disabled INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,               -- bcrypt ($2a$...) nhập từ Supabase, hoặc pbkdf2$... sau lần đăng nhập đầu
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions (refresh_hash);

CREATE TABLE IF NOT EXISTS login_attempts (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO counters (name, v) VALUES ('seq', 0);

CREATE TABLE IF NOT EXISTS checkpoints (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  shift TEXT NOT NULL,
  section TEXT NOT NULL,
  po TEXT NOT NULL DEFAULT '',
  item_code TEXT NOT NULL DEFAULT '',
  recipe TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  technician TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  field_notes TEXT NOT NULL DEFAULT '{}',
  images TEXT NOT NULL DEFAULT '[]',         -- chỉ metadata [{ts,name,size}]; nội dung ảnh nằm ở R2
  images_fp TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_seq ON checkpoints (seq);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_updated ON meta (updated_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  date TEXT, shift TEXT, po TEXT, section TEXT, technician TEXT,
  changes TEXT NOT NULL DEFAULT '[]',
  user_name TEXT, machine TEXT, action TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts);

CREATE TABLE IF NOT EXISTS member_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT, actor_name TEXT, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
