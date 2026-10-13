-- 2Pay V2.2: Team nodes (waiters) and tips. SAFE TO RE-RUN (idempotent). Run AFTER v2_1.sql and BEFORE deploying V2.2.
--
-- A business adds any number of team members (waiters or cashiers). Every sale a team member keys is stamped with
-- their id, so the master terminal can show who took it, and a payment larger than the receipt is split into
-- revenue and tip. Nothing here moves money: sales still settle straight to the business's own bank or wallet.
--
-- Naming: the team members table is the existing `merchant_staff` (V2.1), extended below. "waiter_id" is `staff_id`,
-- "receipt_amount" is `amount` (the locked bill), "calculated_tip" is `tip_amount`, "settled_amount" is unchanged.

-- ------------------------------------------------------------------ team members
alter table merchant_staff add column if not exists team_no           text;
alter table merchant_staff add column if not exists invite_token_hash text;          -- sha256 of the link token; the token itself is never stored
alter table merchant_staff add column if not exists invite_expires_at timestamptz;
alter table merchant_staff add column if not exists invited_at        timestamptz not null default now();
alter table merchant_staff add column if not exists activated_at      timestamptz;   -- set when the person opens the link and verifies their phone
alter table merchant_staff add column if not exists device_id_hash    text;          -- sha256 of the random id of the phone they activated on
alter table merchant_staff add column if not exists device_label      text;          -- e.g. "Android" (from the user agent), for the owner's list
alter table merchant_staff add column if not exists last_seen_at      timestamptz;

alter table merchant_staff drop constraint if exists merchant_staff_role_check;
alter table merchant_staff add constraint merchant_staff_role_check check (role in ('CASHIER', 'WAITER'));

-- Existing cashiers get a team number too (C-001, C-002 ...), oldest first.
with numbered as (
  select id, row_number() over (partition by merchant_id order by created_at, id) as n
    from merchant_staff
   where team_no is null
)
update merchant_staff s
   set team_no = 'C-' || lpad(numbered.n::text, 3, '0')
  from numbered
 where s.id = numbered.id;

-- Team numbers are unique inside one business (a removed member keeps theirs, so reports stay readable).
create unique index if not exists merchant_staff_team_no_uq on merchant_staff (merchant_id, team_no) where team_no is not null;
create unique index if not exists merchant_staff_invite_uq  on merchant_staff (invite_token_hash) where invite_token_hash is not null;

-- ------------------------------------------------------------------ sales
alter table transactions add column if not exists staff_id   uuid references merchant_staff(id);
alter table transactions add column if not exists tip_amount numeric(12,2) not null default 0;

alter table transactions drop constraint if exists transactions_tip_amount_chk;
alter table transactions add constraint transactions_tip_amount_chk check (tip_amount >= 0);

-- Per-person ledgers ("Abebe, today") read by merchant, person and time.
create index if not exists transactions_staff_idx on transactions (merchant_id, staff_id, created_at desc) where staff_id is not null;

-- ------------------------------------------------------------------ access
-- Server-only, like every other table that holds people or money: row-level security on, no policy and no grant
-- for the public roles, so the public key can read nothing. The server (service role) checks the session, the
-- tenant (a session only ever sees its own merchant) and the role (owner / cashier / waiter) before it answers.
alter table merchant_staff enable row level security;
revoke all on merchant_staff from anon, authenticated;
grant  all on merchant_staff to service_role;
grant  all on transactions   to service_role;

notify pgrst, 'reload schema';
