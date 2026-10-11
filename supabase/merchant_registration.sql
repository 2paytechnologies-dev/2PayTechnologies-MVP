-- 2Pay merchant registration (phone + OTP). SAFE TO RE-RUN (idempotent).
-- Run AFTER pilot_reconcile.sql and multi_rail_routing.sql.

-- A merchant account is a merchants row with a verified phone number.
alter table merchants add column if not exists phone             text;
alter table merchants add column if not exists phone_verified_at timestamptz;

-- One account per phone number. Partial, so the seeded merchants (no phone) are unaffected.
create unique index if not exists merchants_phone_uq on merchants (phone) where phone is not null;

-- One-time codes. Only a keyed hash of the code is stored, never the code itself.
create table if not exists otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  purpose     text not null check (purpose in ('register', 'login')),
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists otp_challenges_phone_idx on otp_challenges (phone, created_at desc);

-- Server-only: nothing here is reachable with the public anon key.
alter table otp_challenges enable row level security;
revoke all on otp_challenges from anon, authenticated;
grant all on otp_challenges to service_role;

-- Re-assert the public column allow-list so `phone` (and the saved/active accounts) can never be read
-- with the anon key, regardless of which migration ran first.
revoke select on merchants from anon, authenticated;
grant select (id, business_name, category, terminal_id, location) on merchants to anon, authenticated;
grant all on merchants to service_role;

notify pgrst, 'reload schema';
