-- Neural Board cloud projects, phase 1 (clips + images only).
create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  source_audio_name text,
  source_audio_type text,
  source_audio_size bigint check (source_audio_size is null or source_audio_size >= 0),
  source_audio_duration double precision check (source_audio_duration is null or source_audio_duration >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner text not null
);
create index if not exists projects_owner_updated_idx on public.projects(owner, updated_at desc);

create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  start_time double precision not null check (start_time >= 0),
  end_time double precision not null check (end_time > start_time),
  transcript text not null default '',
  reason text not null default '',
  approved boolean not null default true,
  audio_storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists clips_project_idx on public.clips(project_id, start_time);

create table if not exists public.project_images (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null unique,
  uploaded_at timestamptz not null default now(),
  caption text not null default ''
);
create index if not exists project_images_project_idx on public.project_images(project_id, uploaded_at desc);

create or replace function public.touch_project_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  update public.projects set updated_at = now() where id = new.project_id;
  return new;
end $$;
drop trigger if exists clips_touch_project on public.clips;
create trigger clips_touch_project after insert or update on public.clips
for each row execute function public.touch_project_updated_at();
drop trigger if exists images_touch_project on public.project_images;
create trigger images_touch_project after insert or update on public.project_images
for each row execute function public.touch_project_updated_at();

alter table public.projects enable row level security;
alter table public.clips enable row level security;
alter table public.project_images enable row level security;
revoke all on public.projects, public.clips, public.project_images from anon, authenticated;
-- Deliberately no anon/authenticated RLS policies: only the server's service role can access rows.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-clips', 'project-clips', false, 6291456, array['audio/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-images', 'project-images', false, 15728640, array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Even if another feature later adds a broad permissive Storage policy, this restrictive policy
-- keeps these two buckets inaccessible to browser roles. The service role bypasses RLS.
drop policy if exists "project assets server only" on storage.objects;
create policy "project assets server only" on storage.objects as restrictive
for all to anon, authenticated
using (bucket_id not in ('project-clips', 'project-images'))
with check (bucket_id not in ('project-clips', 'project-images'));
