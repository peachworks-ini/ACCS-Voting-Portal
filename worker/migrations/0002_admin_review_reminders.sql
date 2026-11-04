CREATE TABLE IF NOT EXISTS admin_review_reminder_runs (
  slot TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  pending_count INTEGER NOT NULL
);
