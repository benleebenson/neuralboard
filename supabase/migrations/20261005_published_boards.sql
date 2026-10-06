-- Published boards: an owner publishes a board to the Home feed for anyone to view read-only.
-- Neural Board uses NextAuth, not Supabase Auth, so every read and write passes through
-- server routes using the service-role key. The browser roles get no table or storage access.
create extension if not exists pgcrypto;

create table if not exists public.published_boards (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  -- The board's .nbp file name in the owner's boards folder; one publication per owner per file.
  board_key text not null check (char_length(board_key) between 1 and 255),
  title text not null check (char_length(title) between 1 and 120),
  -- Null until the first upload completes; a row without paths is never listed.
  package_path text,
  preview_path text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_email, board_key)
);
create index if not exists published_boards_feed_idx on public.published_boards(published_at desc) where published_at is not null;

alter table public.published_boards enable row level security;
revoke all on public.published_boards from anon, authenticated;
-- No policies: with RLS on and privileges revoked, only the service role can read or write.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('published-boards', 'published-boards', false, 52428800, array['application/zip', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "published boards server only" on storage.objects;
create policy "published boards server only" on storage.objects as restrictive
for all to anon, authenticated
using (bucket_id <> 'published-boards')
with check (bucket_id <> 'published-boards');
