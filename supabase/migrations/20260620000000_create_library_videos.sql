-- library_videos: per-user saved YouTube video metadata
--
-- NOTE: This app authenticates via NextAuth (Google OAuth), not Supabase Auth.
-- The service_role key is used for all DB access, which bypasses RLS.
-- Ownership is enforced at the API layer by filtering on `email`.
-- RLS policies below are included for completeness / future Supabase Auth migration.

create table library_videos (
  id               uuid        primary key default gen_random_uuid(),
  email            text        not null,
  youtube_url      text        not null default '',
  youtube_video_id text        not null,
  title            text        not null default '',
  thumbnail_url    text        not null default '',
  duration_seconds int         not null default 0,
  created_at       timestamptz not null default now()
);

create index library_videos_email_idx
  on library_videos (email);

create unique index library_videos_email_video_idx
  on library_videos (email, youtube_video_id);

alter table library_videos enable row level security;

create policy "Users can view own library videos"
  on library_videos for select
  using (auth.email() = email);

create policy "Users can insert own library videos"
  on library_videos for insert
  with check (auth.email() = email);

create policy "Users can delete own library videos"
  on library_videos for delete
  using (auth.email() = email);
