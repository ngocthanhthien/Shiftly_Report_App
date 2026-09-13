-- Migration for deployments created BEFORE the "seq" sync cursor fix.
-- Run this ONCE if your database already existed (i.e. you ran schema.sql
-- before this file existed). New deployments get this via schema.sql
-- directly and do NOT need to run this file.
--
--   npx wrangler d1 execute shiftly_report_db --remote --file=./migrate_v2_add_seq.sql
--
-- Why this is needed: the sync cursor used to be based on each device's own
-- clock (`updated_at`, set by the browser). Two devices' clocks are never
-- perfectly in sync — a phone in particular can silently drift or have the
-- wrong date set — so a checkpoint pushed with an earlier client-side
-- timestamp than another device's last-seen cursor was excluded from that
-- device's pulls FOREVER, even though it was a genuinely new change, with
-- no error shown anywhere. `seq` is a plain counter assigned by the server
-- in write order, independent of any device's clock, which fixes this.

ALTER TABLE checkpoints ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_checkpoints_seq ON checkpoints(seq);

CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_seq (id, value) VALUES (1, 0);

-- Backfill: give existing rows increasing seq numbers in their current
-- updated_at order, so nothing already stored gets lost from future
-- incremental pulls, then move the counter past the highest one used.
UPDATE checkpoints SET seq = (
  SELECT COUNT(*) FROM checkpoints c2 WHERE c2.updated_at <= checkpoints.updated_at
);
UPDATE sync_seq SET value = (SELECT COALESCE(MAX(seq), 0) FROM checkpoints) WHERE id = 1;
