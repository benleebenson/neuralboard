-- Anonymous publishing: a signed-out creator's Save also publishes the board to the Home feed with
-- its join code, so they can find and reopen it from another device. Such publications have no
-- owner_email; they're tied to a joinable board (join_code), proven by its owner token, and expire
-- with it (expires_at, copied from joinable_boards; cleared when the board is saved to an account).
alter table public.published_boards alter column owner_email drop not null;
alter table public.published_boards add column if not exists join_code text;
alter table public.published_boards add column if not exists expires_at timestamptz;
create unique index if not exists published_boards_join_code_key on public.published_boards(join_code) where join_code is not null;
