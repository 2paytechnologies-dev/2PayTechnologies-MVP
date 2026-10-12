-- 2Pay: every migration up to V2.1, in order. Safe to re-run. Does NOT include lockdown_reads.sql:
-- run that only AFTER the matching release is deployed (see docs/GO_LIVE.md).

-- ============================================================
-- pilot_reconcile.sql
-- ============================================================
-- 2Pay pilot reconcile migration. SAFE TO RE-RUN (idempotent).
--
-- The pilot tables (ad_campaigns, ad_impressions, watchdog_events) were created
-- by an earlier migration whose definition is not in this repo. This file makes
-- the schema match exactly what the application code reads and writes, using
-- "create ... if not exists" / "add column if not exists" so it is a no-op for
-- anything that already matches. Run it in the Supabase SQL editor.
--
-- Security model:
--   * transactions / merchants : unchanged (anon read, anon insert of PENDING rows).
--   * watchdog_events          : anon SELECT only (admin dashboard Realtime listener).
--   * ad_campaigns / ad_impressions : NO anon access. Only the server (service_role)
--     touches them, via /api/ads/* and the SECURITY DEFINER functions below.

-- ---------------------------------------------------------------- transactions
alter table transactions add column if not exists expected_amount numeric(12,2);
alter table transactions add column if not exists settled_amount  numeric(12,2);
alter table transactions add column if not exists settled_at      timestamptz;
alter table transactions add column if not exists arifpay_ref     text;

-- Rows created before this migration expected exactly their requested amount.
update transactions set expected_amount = amount where expected_amount is null;

create index if not exists transactions_arifpay_ref_idx on transactions (arifpay_ref) where arifpay_ref is not null;
create index if not exists transactions_merchant_created_idx on transactions (merchant_id, created_at desc);

-- Lifecycle: PENDING -> SUCCESS (customer authorized) -> SETTLED (Arifpay confirmed).
alter table transactions drop constraint if exists transactions_status_check;
alter table transactions add constraint transactions_status_check
  check (status in ('PENDING', 'SUCCESS', 'SETTLED', 'FAILED'));

-- ------------------------------------------------------------------- merchants
alter table merchants add column if not exists location text;

-- ---------------------------------------------------------------- ad_campaigns
create table if not exists ad_campaigns (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid references merchants(id),
  title            text not null,
  description      text not null default '',
  target_category  text not null default 'ALL',
  image_url        text,
  phone_cta        text,
  location_cta     text,
  budget           numeric(12,2) not null check (budget > 0),
  remaining_budget numeric(12,2) not null check (remaining_budget >= 0),
  impressions_count integer not null default 0,
  clicks_count     integer not null default 0,
  status           text not null default 'ACTIVE',
  created_at       timestamptz not null default now()
);

alter table ad_campaigns add column if not exists merchant_id uuid references merchants(id);
alter table ad_campaigns add column if not exists description text not null default '';
alter table ad_campaigns add column if not exists target_category text not null default 'ALL';
alter table ad_campaigns add column if not exists image_url text;
alter table ad_campaigns add column if not exists phone_cta text;
alter table ad_campaigns add column if not exists location_cta text;
alter table ad_campaigns add column if not exists budget numeric(12,2);
alter table ad_campaigns add column if not exists remaining_budget numeric(12,2);
alter table ad_campaigns add column if not exists impressions_count integer not null default 0;
alter table ad_campaigns add column if not exists clicks_count integer not null default 0;
alter table ad_campaigns add column if not exists status text not null default 'ACTIVE';

alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in ('ACTIVE', 'PAUSED', 'EXHAUSTED'));

create index if not exists ad_campaigns_serve_idx on ad_campaigns (status, target_category);

-- --------------------------------------------------------------- ad_impressions
create table if not exists ad_impressions (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references ad_campaigns(id),
  transaction_id uuid not null references transactions(id),
  cost           numeric(12,2) not null default 0.05,
  clicked        boolean not null default false,
  created_at     timestamptz not null default now()
);

alter table ad_impressions add column if not exists cost    numeric(12,2) not null default 0.05;
alter table ad_impressions add column if not exists clicked boolean not null default false;

-- One billed impression per (campaign, transaction): receipt reloads never double-bill.
create unique index if not exists ad_impressions_campaign_tx_uq on ad_impressions (campaign_id, transaction_id);

-- ------------------------------------------------------------- watchdog_events
create table if not exists watchdog_events (
  id             uuid primary key default gen_random_uuid(),
  event_type     text not null,
  severity       text not null default 'WARNING',
  risk_score     integer not null default 0,
  merchant_id    uuid references merchants(id),
  transaction_id uuid references transactions(id),
  message        text not null default '',
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table watchdog_events add column if not exists event_type text;
alter table watchdog_events add column if not exists severity text not null default 'WARNING';
alter table watchdog_events add column if not exists risk_score integer not null default 0;
alter table watchdog_events add column if not exists merchant_id uuid references merchants(id);
alter table watchdog_events add column if not exists transaction_id uuid references transactions(id);
alter table watchdog_events add column if not exists message text not null default '';
alter table watchdog_events add column if not exists details jsonb not null default '{}'::jsonb;

create index if not exists watchdog_events_created_idx on watchdog_events (created_at desc);
create index if not exists watchdog_events_merchant_idx on watchdog_events (merchant_id, created_at desc);

-- ------------------------------------------------------------------ RLS / grants
alter table ad_campaigns    enable row level security;
alter table ad_impressions  enable row level security;
alter table watchdog_events enable row level security;

revoke all on ad_campaigns, ad_impressions from anon, authenticated;
revoke all on watchdog_events from anon, authenticated;
grant select on watchdog_events to anon, authenticated;

drop policy if exists "watchdog readable" on watchdog_events;
create policy "watchdog readable" on watchdog_events for select using (true);

grant all on ad_campaigns, ad_impressions, watchdog_events to service_role;
grant all on transactions, merchants to service_role;

-- ---------------------------------------------------------------------- functions
-- Atomic, idempotent micro-billing. The campaign row is locked so concurrent
-- receipts cannot overspend; the unique index makes retries free.
create or replace function record_ad_impression(p_campaign_id uuid, p_transaction_id uuid, p_cost numeric default 0.05)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c ad_campaigns;
begin
  if not exists (select 1 from transactions where id = p_transaction_id and status in ('SUCCESS', 'SETTLED')) then
    raise exception 'TRANSACTION_NOT_ELIGIBLE';
  end if;

  select * into c from ad_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'CAMPAIGN_NOT_FOUND';
  end if;

  if exists (select 1 from ad_impressions where campaign_id = p_campaign_id and transaction_id = p_transaction_id) then
    return jsonb_build_object('recorded', false, 'reason', 'DUPLICATE',
                              'remaining_budget', c.remaining_budget, 'status', c.status);
  end if;

  if c.status <> 'ACTIVE' or c.remaining_budget < p_cost then
    if c.status = 'ACTIVE' then
      update ad_campaigns set status = 'EXHAUSTED' where id = p_campaign_id returning * into c;
    end if;
    return jsonb_build_object('recorded', false, 'reason', 'NOT_SERVING',
                              'remaining_budget', c.remaining_budget, 'status', c.status);
  end if;

  insert into ad_impressions (campaign_id, transaction_id, cost) values (p_campaign_id, p_transaction_id, p_cost);

  update ad_campaigns
     set remaining_budget  = remaining_budget - p_cost,
         impressions_count = impressions_count + 1,
         status            = case when remaining_budget - p_cost < p_cost then 'EXHAUSTED' else status end
   where id = p_campaign_id
  returning * into c;

  return jsonb_build_object('recorded', true, 'reason', null,
                            'remaining_budget', c.remaining_budget, 'status', c.status);
end $$;

-- Counts at most one click per impression.
create or replace function record_ad_click(p_campaign_id uuid, p_transaction_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  hit uuid;
begin
  update ad_impressions set clicked = true
   where campaign_id = p_campaign_id and transaction_id = p_transaction_id and not clicked
  returning id into hit;

  if hit is null then
    return jsonb_build_object('recorded', false);
  end if;

  update ad_campaigns set clicks_count = clicks_count + 1 where id = p_campaign_id;
  return jsonb_build_object('recorded', true);
end $$;

revoke all on function record_ad_impression(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function record_ad_click(uuid, uuid)               from public, anon, authenticated;
grant execute on function record_ad_impression(uuid, uuid, numeric) to service_role;
grant execute on function record_ad_click(uuid, uuid)               to service_role;

-- ---------------------------------------------------------------------- Realtime
alter table watchdog_events replica identity full;
do $$ begin
  alter publication supabase_realtime add table watchdog_events;
exception when duplicate_object then null; end $$;

-- PostgREST schema cache reload so new columns/functions are visible immediately.
notify pgrst, 'reload schema';


-- ============================================================
-- multi_rail_routing.sql
-- ============================================================
-- 2Pay Multi-Rail Settlement Routing. SAFE TO RE-RUN (idempotent).
-- Run AFTER supabase/pilot_reconcile.sql, and deploy the matching app release at the same time:
-- this migration locks down columns/policies that the previous release still uses.
--
-- Model
--   merchants.saved_banks / saved_wallets : up to 3 accounts each
--                                           [{ "id": uuid, "institution": text, "account_number": text }]
--   merchants.active_bank / active_wallet : the ONE account of each kind that receives payments
--                                           { "id", "institution", "account_number" } or NULL
--   transactions.routed_bank / routed_wallet : snapshot of the active accounts when the pay node was
--                                           created, MASKED { "id", "institution", "account_masked" }
--   The payer picks one; the DB validates the pick and stamps rail + settlement_method.

-- ------------------------------------------------------------------ merchants
alter table merchants add column if not exists saved_banks   jsonb not null default '[]'::jsonb;
alter table merchants add column if not exists saved_wallets jsonb not null default '[]'::jsonb;
alter table merchants add column if not exists active_bank   jsonb;
alter table merchants add column if not exists active_wallet jsonb;

alter table merchants drop constraint if exists merchants_saved_banks_chk;
alter table merchants add constraint merchants_saved_banks_chk
  check (jsonb_typeof(saved_banks) = 'array' and jsonb_array_length(saved_banks) <= 3);

alter table merchants drop constraint if exists merchants_saved_wallets_chk;
alter table merchants add constraint merchants_saved_wallets_chk
  check (jsonb_typeof(saved_wallets) = 'array' and jsonb_array_length(saved_wallets) <= 3);

alter table merchants drop constraint if exists merchants_active_bank_chk;
alter table merchants add constraint merchants_active_bank_chk
  check (active_bank is null or jsonb_typeof(active_bank) = 'object');

alter table merchants drop constraint if exists merchants_active_wallet_chk;
alter table merchants add constraint merchants_active_wallet_chk
  check (active_wallet is null or jsonb_typeof(active_wallet) = 'object');

-- Account numbers must never be readable with the public anon key. Expose only the public
-- columns; the saved_* / active_* columns are reachable solely through server routes (service_role).
revoke select on merchants from anon, authenticated;
grant select (id, business_name, category, terminal_id, location) on merchants to anon, authenticated;
grant all on merchants to service_role;

-- --------------------------------------------------------------- transactions
alter table transactions add column if not exists routed_bank       jsonb;
alter table transactions add column if not exists routed_wallet     jsonb;
alter table transactions add column if not exists settlement_method text;

alter table transactions drop constraint if exists transactions_settlement_method_chk;
alter table transactions add constraint transactions_settlement_method_chk
  check (settlement_method is null or settlement_method in ('BANK', 'WALLET'));

-- `rail` now holds the institution the payer chose (e.g. "Awash Bank", "Telebirr"), not one of 3 fixed values.
alter table transactions drop constraint if exists transactions_rail_check;

-- Pay nodes are now created only by /api/transactions (service_role), which snapshots the merchant's
-- active routing server-side. Direct anon inserts would let a caller forge routing, so close them.
drop policy if exists "transactions create" on transactions;

-- ------------------------------------------------------------------ functions
-- open_transaction gains routed_bank / routed_wallet, so its return type changes: drop and recreate.
drop function if exists open_transaction(uuid);
create function open_transaction(p_token uuid)
returns table (
  token uuid, amount numeric, currency text, status text, rail text,
  expires_at timestamptz, merchant_name text, merchant_category text, terminal_id text,
  routed_bank jsonb, routed_wallet jsonb
)
language plpgsql security definer set search_path = public as $$
begin
  update transactions t set viewed_at = now()
   where t.token = p_token and t.viewed_at is null and t.status = 'PENDING' and t.expires_at > now();

  return query
    select t.token, t.amount, t.currency, t.status, t.rail, t.expires_at,
           m.business_name, m.category, m.terminal_id, t.routed_bank, t.routed_wallet
      from transactions t join merchants m on m.id = t.merchant_id
     where t.token = p_token;
end $$;

-- Payer chooses 'BANK' or 'WALLET'. The institution comes from the transaction's own routing
-- snapshot, never from the client, so a payer cannot settle through an institution the merchant
-- did not enable. Atomic and single-use, like the function it replaces.
create or replace function authorize_transaction_v2(p_token uuid, p_method text)
returns transactions
language plpgsql security definer set search_path = public as $$
declare
  v_method text := upper(coalesce(p_method, ''));
  v_rail   text;
  result   transactions;
begin
  if v_method not in ('BANK', 'WALLET') then
    raise exception 'METHOD_NOT_AVAILABLE';
  end if;

  select case v_method when 'BANK' then t.routed_bank ->> 'institution'
                       else t.routed_wallet ->> 'institution' end
    into v_rail
    from transactions t where t.token = p_token;

  if v_rail is null then
    raise exception 'METHOD_NOT_AVAILABLE';
  end if;

  update transactions t
     set status = 'SUCCESS',
         rail = v_rail,
         settlement_method = v_method,
         latency_ms = greatest(1, (extract(epoch from (now() - coalesce(t.viewed_at, t.created_at))) * 1000)::int)
   where t.token = p_token and t.status = 'PENDING' and t.expires_at > now()
  returning * into result;

  if result.id is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED';
  end if;
  return result;
end $$;

grant execute on function open_transaction(uuid)                 to anon, authenticated;
grant execute on function authorize_transaction_v2(uuid, text)   to anon, authenticated;

-- The v1 function accepted any rail string from the caller. Retire it from the public roles.
revoke execute on function authorize_transaction(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';


-- ============================================================
-- merchant_registration.sql
-- ============================================================
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


-- ============================================================
-- rails_live.sql
-- ============================================================
-- 2Pay live rails. SAFE TO RE-RUN (idempotent). Run AFTER the earlier migrations; safe to run BEFORE deploying.
--
-- Adds what a real payment provider needs on a transaction, a PROCESSING state, and an audit table that keeps
-- every raw webhook so provider payload mappings can be corrected without losing events.

-- Lifecycle: PENDING -> PROCESSING (payer sent to the provider) -> SETTLED | FAILED.
-- In simulated mode the old PENDING -> SUCCESS -> SETTLED path still exists.
alter table transactions drop constraint if exists transactions_status_check;
alter table transactions add constraint transactions_status_check
  check (status in ('PENDING', 'PROCESSING', 'SUCCESS', 'SETTLED', 'FAILED'));

alter table transactions add column if not exists rail_provider     text;
alter table transactions add column if not exists rail_session_id   text;
alter table transactions add column if not exists rail_nonce        text;
alter table transactions add column if not exists rail_checkout_url text;
alter table transactions add column if not exists processing_at     timestamptz;

-- The nonce is the correlation id the provider echoes back in its webhook.
create unique index if not exists transactions_rail_nonce_uq on transactions (rail_nonce) where rail_nonce is not null;
create index if not exists transactions_processing_idx on transactions (processing_at) where status = 'PROCESSING';

-- Every inbound provider webhook, valid or not.
create table if not exists rail_events (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  transaction_id uuid references transactions(id),
  nonce          text,
  signature_ok   boolean not null,
  event_status   text,
  applied        boolean not null default false,
  note           text,
  payload        jsonb not null default '{}'::jsonb,
  received_at    timestamptz not null default now()
);

create index if not exists rail_events_received_idx on rail_events (received_at desc);
create index if not exists rail_events_nonce_idx on rail_events (nonce);

alter table rail_events enable row level security;
revoke all on rail_events from anon, authenticated;
grant all on rail_events to service_role;
grant all on transactions to service_role;

notify pgrst, 'reload schema';


-- ============================================================
-- v2_1.sql
-- ============================================================
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

