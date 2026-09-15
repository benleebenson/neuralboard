create table if not exists public.joinable_boards (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  owner_email text not null,
  owner_token_hash text not null,
  state jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  active boolean not null default true,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists joinable_boards_active_expiry_idx on public.joinable_boards(code, active, expires_at);
alter table public.joinable_boards enable row level security;
revoke all on public.joinable_boards from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('joinable-board-media', 'joinable-board-media', false, 15728640, array['image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
