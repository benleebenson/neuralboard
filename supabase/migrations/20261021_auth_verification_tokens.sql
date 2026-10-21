-- Email magic-link sign-in (NextAuth EmailProvider). NextAuth stores only a hash of each link's
-- token here; a token is deleted when used and is good until `expires` (24h by default).
-- Sessions stay JWT and users stay keyed by email in nb_users, so no users/accounts/sessions
-- tables are needed. Like the other tables, it's reached only through server routes using the
-- service-role key.
create table if not exists public.verification_tokens (
  identifier text not null,
  token text not null,
  expires timestamptz not null,
  primary key (identifier, token)
);
create index if not exists verification_tokens_expires_idx on public.verification_tokens(expires);
alter table public.verification_tokens enable row level security;
revoke all on public.verification_tokens from anon, authenticated;
