-- Shiftly Report — D1 schema
-- Run once: wrangler d1 execute shiftly_report_db --file=./schema.sql (add --remote for the live DB)

CREATE TABLE IF NOT EXISTS checkpoints (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  shift TEXT NOT NULL,
  section TEXT NOT NULL,
  po TEXT DEFAULT '',
  recipe TEXT DEFAULT '',
  client TEXT DEFAULT '',
  technician TEXT DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '{}',
  field_notes_json TEXT NOT NULL DEFAULT '{}',
  images_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_updated ON checkpoints(updated_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_date_shift ON checkpoints(date, shift);
CREATE INDEX IF NOT EXISTS idx_checkpoints_po ON checkpoints(po);
CREATE INDEX IF NOT EXISTS idx_checkpoints_seq ON checkpoints(seq);

-- Single-row counter used to assign `seq` in server write-order — the sync
-- cursor is based on this, NEVER on a device's own clock (see worker.js).
CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  date TEXT,
  shift TEXT,
  po TEXT,
  section TEXT,
  technician TEXT,
  changes_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
