-- Apply to the existing Worker DB. Does not change users or sessions.
CREATE TABLE IF NOT EXISTS discord_announcements (
  suggestion_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS discord_announcements_due ON discord_announcements(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS discord_announcements_owner ON discord_announcements(discord_id, created_at);
