-- Run this in your Supabase project → SQL Editor

CREATE TABLE IF NOT EXISTS nb_users (
  email        TEXT PRIMARY KEY,
  name         TEXT,
  image        TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nb_events (
  id               BIGSERIAL PRIMARY KEY,
  email            TEXT NOT NULL,
  event            TEXT NOT NULL CHECK (event IN ('login', 'transcribe', 'render', 'download')),
  duration_seconds FLOAT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta             JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_nb_events_email ON nb_events (email);
CREATE INDEX IF NOT EXISTS idx_nb_events_event ON nb_events (event);
CREATE INDEX IF NOT EXISTS idx_nb_events_created_at ON nb_events (created_at DESC);
