-- character_animations: per-user authored stick-figure pose animations for Board 2.0 Pose Lab
--
-- The app currently authenticates through NextAuth and accesses Supabase with the service_role
-- key, so ownership is enforced in API routes by filtering on `email`, matching library_videos.
-- `user_id` + auth.uid() RLS policies are included for future Supabase Auth clients.

create table character_animations (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        default auth.uid(),
  email      text        not null default coalesce(auth.email(), ''),
  name       text        not null,
  data       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index character_animations_email_idx
  on character_animations (email);

create unique index character_animations_email_name_idx
  on character_animations (email, name);

alter table character_animations enable row level security;

create policy "Users can view own character animations"
  on character_animations for select
  using (auth.uid() = user_id or auth.email() = email);

create policy "Users can insert own character animations"
  on character_animations for insert
  with check (auth.uid() = user_id or auth.email() = email);

create policy "Users can update own character animations"
  on character_animations for update
  using (auth.uid() = user_id or auth.email() = email)
  with check (auth.uid() = user_id or auth.email() = email);

create policy "Users can delete own character animations"
  on character_animations for delete
  using (auth.uid() = user_id or auth.email() = email);
