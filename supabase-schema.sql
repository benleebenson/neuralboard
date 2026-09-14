-- Run this in your Supabase project → SQL Editor

CREATE TABLE IF NOT EXISTS nb_users (
  email        TEXT PRIMARY KEY,
  name         TEXT,
  image        TEXT,
  credits      INTEGER NOT NULL DEFAULT 10,
  is_admin     BOOLEAN NOT NULL DEFAULT false,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Run these if the table already exists (adds columns idempotently):
ALTER TABLE nb_users ADD COLUMN IF NOT EXISTS credits  INTEGER NOT NULL DEFAULT 10;
ALTER TABLE nb_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

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

-- Asset library (board2): images/YouTube clips placed on a board, kept for reuse across boards.
CREATE TABLE IF NOT EXISTS nb_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('image', 'youtube')),
  url           TEXT,             -- image src; null for youtube
  thumbnail_url TEXT,             -- image src, or the youtube mqdefault thumbnail
  youtube_id    TEXT,             -- youtube only
  yt_start      NUMERIC,          -- youtube only, seconds
  yt_end        NUMERIC,          -- youtube only, seconds
  label         TEXT,             -- optional display name / caption
  source        TEXT,             -- 'auto-build' | 'manual' | 'top5' | ...
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nb_assets_email ON nb_assets (email);

-- Dedup per email. Postgres never treats NULL as equal to NULL in a unique index, so image rows
-- (youtube_id/yt_start/yt_end all null) never collide under the youtube index and vice versa.
CREATE UNIQUE INDEX IF NOT EXISTS nb_assets_image_unique ON nb_assets (email, url);
CREATE UNIQUE INDEX IF NOT EXISTS nb_assets_youtube_unique ON nb_assets (email, youtube_id, yt_start, yt_end);
