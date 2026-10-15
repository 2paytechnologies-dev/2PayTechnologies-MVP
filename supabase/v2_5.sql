-- 2Pay V2.5: tiered fees with VAT in the ledger, Fayda FAN e-KYC, and the ride-hailing partner integration.
-- SAFE TO RE-RUN (idempotent). Run AFTER v2_4.sql and BEFORE deploying V2.5.

-- ------------------------------------------------------------------ the fee ledger
-- Every sale now records exactly what 2Pay charged: the fee before VAT, the 15% VAT on that fee, and what the merchant is
-- paid. Ten-thousandths of an ETB (the schedule produces figures like 0.575 and 1.0632). `fee_ft` keeps the total fee
-- (base + VAT) so existing totals keep working; it needs the same extra decimals.
alter table transactions alter column fee_ft type numeric(12,4);
alter table transactions add column if not exists base_fee                numeric(14,4);
alter table transactions add column if not exists vat_fee                 numeric(14,4);
alter table transactions add column if not exists net_merchant_settlement numeric(14,4);
-- (Sales made before V2.5 keep these three empty: their fee came from the old model and is not restated.)

-- ------------------------------------------------------------------ Fayda (national ID) e-KYC by FAN + one-time code
-- fayda_fan is stored ENCRYPTED by the application (never in clear). The unique-person check uses fayda_subject_hash (a keyed hash).
alter table merchants add column if not exists fayda_fan                    text;
alter table merchants add column if not exists fayda_verified               boolean not null default false;
alter table merchants add column if not exists fayda_verification_timestamp timestamptz;
alter table merchants add column if not exists fayda_transaction_id         text;
update merchants set fayda_verified = true, fayda_verification_timestamp = coalesce(fayda_verification_timestamp, fayda_verified_at)
  where fayda_verified_at is not null and fayda_verified = false;

-- One row per "send me a code" request, so a code can be checked a few times at most and only by the business that asked.
-- The FAN is held here (encrypted by the application) only until the code is checked, then erased.
create table if not exists fayda_sessions (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  fan_enc     text,                                -- the FAN, encrypted by the application; set to null once the request is finished
  gateway_ref text not null,                       -- the gateway's own transaction id for this request
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists fayda_sessions_merchant_idx on fayda_sessions (merchant_id, created_at desc);
alter table fayda_sessions enable row level security;
revoke all on fayda_sessions from anon, authenticated;
grant all on fayda_sessions to service_role;

-- ------------------------------------------------------------------ ride-hailing partners (Feres, RIDE, ...)
-- A partner is a business that already has a merchant record in 2Pay: its rides appear in that merchant's ledger. The API key is
-- shown once when the partner is created and only its SHA-256 is kept.
create table if not exists ride_partners (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  merchant_id  uuid not null references merchants(id),
  key_hash     text not null unique,
  key_hint     text not null,                      -- the last 4 characters, so a key can be recognised without being kept
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- One checkout intent from a partner: a ride's fare and where the driver is paid. The driver's account numbers are stored
-- encrypted by the application; the session link given to the driver's phone is stored as a hash.
create table if not exists ride_sessions (
  id              uuid primary key default gen_random_uuid(),
  partner_id      uuid not null references ride_partners(id),
  partner_ride_id text not null,
  driver_id       text not null,
  accounts        jsonb not null,
  amount          numeric(12,2) not null check (amount > 0),
  currency        text not null default 'ETB',
  token_hash      text not null unique,
  status          text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'CANCELLED')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  opened_at       timestamptz,
  paid_at         timestamptz,
  unique (partner_id, partner_ride_id)
);
create index if not exists ride_sessions_partner_idx on ride_sessions (partner_id, created_at desc);

alter table ride_partners  enable row level security;
alter table ride_sessions  enable row level security;
revoke all on ride_partners, ride_sessions from anon, authenticated;
grant all on ride_partners, ride_sessions to service_role;

-- A ride's sale pays the DRIVER's accounts (kept on the sale, encrypted, never sent to a browser), not the partner's.
alter table transactions add column if not exists payee_accounts  jsonb;
alter table transactions add column if not exists ride_session_id uuid references ride_sessions(id);
create index if not exists transactions_ride_session_idx on transactions (ride_session_id) where ride_session_id is not null;
alter table transactions drop constraint if exists transactions_source_chk;
alter table transactions add constraint transactions_source_chk check (source in ('TERMINAL', 'STATIC_QR', 'RIDE'));

notify pgrst, 'reload schema';
