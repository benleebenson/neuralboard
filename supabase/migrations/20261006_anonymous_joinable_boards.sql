-- Anonymous joinable boards: anyone can create a board without an account. Those boards have no
-- owner_email and expire after 5 days unless the creator saves them to an account, which sets
-- owner_email and clears expires_at (null = permanent). /api/board2/cleanup-expired deletes
-- expired anonymous boards and their joinable-board-media objects daily.
alter table public.joinable_boards alter column owner_email drop not null;
alter table public.joinable_boards alter column expires_at drop not null;
create index if not exists joinable_boards_anonymous_expiry_idx
  on public.joinable_boards(expires_at)
  where owner_email is null;
