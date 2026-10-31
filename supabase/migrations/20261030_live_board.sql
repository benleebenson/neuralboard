-- neuralboard.org/live: the one joinable board that address sends people to. A single row (id is
-- always true), set only by the site owner through /api/live-board. If the board is deleted the
-- setting clears itself; a board that's stopped or expired is skipped by /live at read time.
create table if not exists public.live_board (
  id boolean primary key default true check (id),
  code text references public.joinable_boards(code) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.live_board enable row level security;
revoke all on public.live_board from anon, authenticated;
