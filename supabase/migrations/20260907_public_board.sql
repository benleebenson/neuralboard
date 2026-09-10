-- Public Board: anonymous submissions, owner moderation, public approved reads via server routes.
create extension if not exists pgcrypto;

do $$ begin
  create type public.public_board_post_type as enum ('text', 'image');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.public_board_post_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.public_board_posts (
  id uuid primary key default gen_random_uuid(),
  type public.public_board_post_type not null,
  text text check (text is null or char_length(text) <= 280),
  image_storage_path text unique,
  name text check (name is null or char_length(name) <= 60),
  status public.public_board_post_status not null default 'pending',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  ip_hash text not null,
  constraint public_board_content_required check (
    nullif(btrim(coalesce(text, '')), '') is not null or image_storage_path is not null
  ),
  constraint public_board_type_matches check (
    (type = 'text' and nullif(btrim(coalesce(text, '')), '') is not null)
    or (type = 'image' and image_storage_path is not null)
  )
);
create index if not exists public_board_status_created_idx on public.public_board_posts(status, created_at desc);
create index if not exists public_board_ip_created_idx on public.public_board_posts(ip_hash, created_at desc);

create table if not exists public.public_board_submission_events (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists public_board_submission_events_ip_idx
  on public.public_board_submission_events(ip_hash, created_at desc);

alter table public.public_board_posts enable row level security;
alter table public.public_board_submission_events enable row level security;
revoke all on public.public_board_posts, public.public_board_submission_events from anon, authenticated;
-- No browser policies: all reads and writes pass through Neural Board server routes.

create or replace function public.enforce_public_board_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.ip_hash));
  if (select count(*) from public.public_board_submission_events
      where ip_hash = new.ip_hash and created_at > now() - interval '1 hour') >= 5 then
    raise exception using errcode = 'P0001', message = 'PUBLIC_BOARD_RATE_LIMIT';
  end if;
  insert into public.public_board_submission_events(ip_hash) values (new.ip_hash);
  return new;
end $$;
drop trigger if exists public_board_rate_limit on public.public_board_posts;
create trigger public_board_rate_limit before insert on public.public_board_posts
for each row execute function public.enforce_public_board_rate_limit();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('public-board-images', 'public-board-images', false, 4194304, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public board images server only" on storage.objects;
create policy "public board images server only" on storage.objects as restrictive
for all to anon, authenticated
using (bucket_id <> 'public-board-images')
with check (bucket_id <> 'public-board-images');
