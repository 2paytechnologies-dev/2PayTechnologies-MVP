-- 2Pay V2.1 schema. SAFE TO RE-RUN (idempotent). Run AFTER rails_live.sql. Safe to run BEFORE deploying V2.1.
--
-- Adds: business verification (KYC), cashier staff accounts, refund requests, audit log, database-backed rate
-- limiting, error telemetry, provider attempt tracking (smart routing), SMS receipts (payer phones kept in a separate server-only table) and static-QR sales.
-- Every new table is server-only: no access with the public key.

-- ------------------------------------------------------------------ merchants
alter table merchants add column if not exists legal_name        text;
alter table merchants add column if not exists tin               text;
alter table merchants add column if not exists business_license  text;
alter table merchants add column if not exists address           text;
alter table merchants add column if not exists kyc_status        text not null default 'UNVERIFIED';
alter table merchants add column if not exists kyc_submitted_at  timestamptz;
alter table merchants add column if not exists kyc_reviewed_at   timestamptz;
alter table merchants add column if not exists kyc_note          text;
alter table merchants add column if not exists static_qr_enabled boolean not null default true;
alter table merchants add column if not exists sms_receipts      boolean not null default true;
alter table merchants add column if not exists terms_accepted_at timestamptz;

alter table merchants drop constraint if exists merchants_kyc_status_chk;
alter table merchants add constraint merchants_kyc_status_chk
  check (kyc_status in ('UNVERIFIED', 'SUBMITTED', 'VERIFIED', 'REJECTED'));

-- ---------------------------------------------------------------- transactions
alter table transactions add column if not exists source text not null default 'TERMINAL';

alter table transactions drop constraint if exists transactions_source_chk;
alter table transactions add constraint transactions_source_chk check (source in ('TERMINAL', 'STATIC_QR'));

-- ------------------------------------------------------------ payer contacts (personal data)
-- The payer's phone (for the SMS receipt) lives in its own server-only table, NOT on transactions: that table can
-- still be read with the public key until lockdown_reads.sql has been run.
create table if not exists payer_contacts (
  transaction_id uuid primary key references transactions(id) on delete cascade,
  phone          text not null,
  lang           text not null default 'en',
  receipt_sent   boolean not null default false,
  created_at     timestamptz not null default now()
);
-- ----------------------------------------------------------------- staff (cashiers)
-- The merchant's own phone (merchants.phone) is the OWNER. Cashiers can run the terminal and nothing else.
create table if not exists merchant_staff (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  phone       text not null,
  name        text not null,
  role        text not null default 'CASHIER' check (role in ('CASHIER')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists merchant_staff_phone_uq on merchant_staff (phone) where active;
create index if not exists merchant_staff_merchant_idx on merchant_staff (merchant_id);

-- --------------------------------------------------------------- refund requests
-- Moving money back is done with the provider; 2Pay records the request, the decision and the audit trail.
create table if not exists refund_requests (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  merchant_id    uuid not null references merchants(id),
  amount         numeric(12,2) not null check (amount > 0),
  reason         text not null,
  status         text not null default 'REQUESTED' check (status in ('REQUESTED', 'APPROVED', 'REFUNDED', 'REJECTED')),
  requested_by   text,
  admin_note     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists refund_requests_merchant_idx on refund_requests (merchant_id, created_at desc);
create index if not exists refund_requests_status_idx on refund_requests (status, created_at desc);
-- At most one open request per transaction.
create unique index if not exists refund_requests_open_uq on refund_requests (transaction_id) where status in ('REQUESTED', 'APPROVED');

-- ------------------------------------------------------------------- audit log
create table if not exists audit_log (
  id                uuid primary key default gen_random_uuid(),
  actor_phone       text,
  actor_merchant_id uuid,
  role              text,
  action            text not null,
  target_type       text,
  target_id         text,
  ip                text,
  details           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
create index if not exists audit_log_merchant_idx on audit_log (actor_merchant_id, created_at desc);

-- ------------------------------------------------------------ rate limiting
create table if not exists rate_limits (
  key    text not null,
  bucket timestamptz not null,
  hits   integer not null default 0,
  primary key (key, bucket)
);

-- Atomic fixed-window counter. Returns TRUE while the caller is within `p_limit` hits per `p_window_s` seconds.
create or replace function rate_limit_hit(p_key text, p_limit integer, p_window_s integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  v_hits   integer;
begin
  insert into rate_limits as r (key, bucket, hits) values (p_key, v_bucket, 1)
  on conflict (key, bucket) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- ----------------------------------------------------------- error telemetry
create table if not exists app_errors (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  message     text not null,
  stack       text,
  url         text,
  user_agent  text,
  merchant_id uuid,
  created_at  timestamptz not null default now()
);
create index if not exists app_errors_created_idx on app_errors (created_at desc);

-- ----------------------------------------------- provider attempts (smart routing)
create table if not exists rail_attempts (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  institution text,
  ok          boolean not null,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists rail_attempts_provider_idx on rail_attempts (provider, created_at desc);

-- ----------------------------------------------------- access: server-only
alter table merchant_staff  enable row level security;
alter table refund_requests enable row level security;
alter table audit_log       enable row level security;
alter table rate_limits     enable row level security;
alter table app_errors      enable row level security;
alter table rail_attempts   enable row level security;
alter table payer_contacts  enable row level security;

revoke all on merchant_staff, refund_requests, audit_log, rate_limits, app_errors, rail_attempts, payer_contacts from anon, authenticated;
grant  all on merchant_staff, refund_requests, audit_log, rate_limits, app_errors, rail_attempts, payer_contacts to service_role;

revoke execute on function rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant  execute on function rate_limit_hit(text, integer, integer) to service_role;

-- merchants / transactions: the new columns hold personal and business data. Public-role privileges on these two
-- tables are owned by multi_rail_routing.sql (column allow-list) and lockdown_reads.sql (none), so they are not touched here.
grant all on merchants to service_role;
grant all on transactions to service_role;

notify pgrst, 'reload schema';
