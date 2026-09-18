alter table nb_assets add column if not exists description text;
alter table nb_assets add column if not exists embedding jsonb;
alter table nb_assets add column if not exists storage_path text;
alter table nb_assets add column if not exists is_intro boolean not null default false;

create unique index if not exists nb_assets_storage_unique on nb_assets (email, storage_path);
create index if not exists nb_assets_intro_idx on nb_assets (email, is_intro) where is_intro = true;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('asset-library', 'asset-library', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
