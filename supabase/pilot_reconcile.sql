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
