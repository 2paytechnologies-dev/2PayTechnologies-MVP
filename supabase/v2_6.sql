-- 2Pay V2.6: ride-hailing companies kept apart from merchants, the AI event outbox, and server-side admin aggregates.
-- SAFE TO RE-RUN (idempotent). Run AFTER v2_5.sql and BEFORE deploying V2.6.

-- ------------------------------------------------------------------ ride-hailing companies are not merchants
-- A ride company's rides are recorded in a ledger record of its own. That record is a `merchants` row (every sale belongs to one) but
-- of kind RIDE_PARTNER: it has no phone (nobody can sign in as it), is never listed with the merchants, and is created by an admin.
alter table merchants add column if not exists kind text not null default 'MERCHANT';
alter table merchants drop constraint if exists merchants_kind_chk;
alter table merchants add constraint merchants_kind_chk check (kind in ('MERCHANT', 'RIDE_PARTNER'));
create index if not exists merchants_kind_idx on merchants (kind);

alter table ride_partners add column if not exists contact_name  text;
alter table ride_partners add column if not exists contact_phone text;

-- ------------------------------------------------------------------ the AI event outbox
-- Every sale writes small events here (created, started, settled, failed) in the same database as the sale. A dispatcher sends them to the
-- AI layer and retries until they are delivered, so a slow or unreachable AI service never delays or loses anything. The payload is
-- pseudonymised by the application before it is written: no account numbers, phones or names.
create table if not exists ai_event_outbox (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  stage           text not null,
  tx_ref          text,                    -- the pseudonymous sale reference carried in the event (what a returning score names)
  transaction_id  uuid,                    -- the sale itself; never sent out
  payload         jsonb not null,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  last_error      text
);
create index if not exists ai_event_outbox_pending_idx on ai_event_outbox (next_attempt_at) where sent_at is null;
create index if not exists ai_event_outbox_txref_idx on ai_event_outbox (tx_ref);

-- Risk scores coming back from the AI layer, keyed by the pseudonymous transaction reference the event carried.
create table if not exists ai_scores (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),
  tx_ref       text not null,
  transaction_id uuid references transactions(id),
  score        integer not null check (score between 0 and 100),
  model        text not null,
  reasons      jsonb not null default '[]'::jsonb
);
create index if not exists ai_scores_tx_idx on ai_scores (transaction_id);

alter table ai_event_outbox enable row level security;
alter table ai_scores       enable row level security;
revoke all on ai_event_outbox, ai_scores from anon, authenticated;
grant all on ai_event_outbox, ai_scores to service_role;

-- ------------------------------------------------------------------ admin aggregates (computed in the database, correct at any volume)
create index if not exists transactions_created_idx on transactions (created_at desc);
create index if not exists transactions_status_created_idx on transactions (status, created_at desc);

-- Network totals for a period: volume, taps, latency, by channel, and the fee ledger.
create or replace function admin_day_stats(p_from timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with paid as (
    select * from transactions where created_at >= p_from and status in ('SUCCESS', 'SETTLED')
  )
  select jsonb_build_object(
    'gmv', coalesce((select sum(amount) from paid), 0),
    'taps', (select count(*) from paid),
    'settled', (select count(*) from paid where status = 'SETTLED'),
    'avg_latency_ms', (select avg(latency_ms) from paid),
    'by_source', coalesce((
      select jsonb_object_agg(src, jsonb_build_object('taps', taps, 'gmv', gmv, 'avg_latency_ms', lat, 'nodes', nodes))
      from (select coalesce(source, 'TERMINAL') as src, count(*) as taps, sum(amount) as gmv, avg(latency_ms) as lat, count(distinct merchant_id) as nodes from paid group by 1) s
    ), '{}'::jsonb),
    'fees', jsonb_build_object(
      'base', coalesce((select sum(base_fee) from paid), 0),
      'vat', coalesce((select sum(vat_fee) from paid), 0),
      'net', coalesce((select sum(net_merchant_settlement) from paid), 0),
      'priced_taps', (select count(base_fee) from paid),
      'legacy_taps', (select count(*) - count(base_fee) from paid)
    )
  );
$$;

-- The busiest nodes by volume with what each was charged (a short list, not every merchant).
create or replace function admin_node_fees(p_from timestamptz, p_limit integer default 25) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by (r->>'gmv')::numeric desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'merchant_id', t.merchant_id, 'business', m.business_name, 'terminal', m.terminal_id,
      'taps', count(*), 'gmv', sum(t.amount),
      'base', coalesce(sum(t.base_fee), 0), 'vat', coalesce(sum(t.vat_fee), 0), 'net', coalesce(sum(t.net_merchant_settlement), 0),
      'legacy', count(*) - count(t.base_fee)
    ) as r
    from transactions t join merchants m on m.id = t.merchant_id
    where t.created_at >= p_from and t.status in ('SUCCESS', 'SETTLED')
    group by t.merchant_id, m.business_name, m.terminal_id
    order by sum(t.amount) desc
    limit greatest(1, least(p_limit, 100))
  ) x;
$$;

-- Evidence summary for the compliance tab: how paid sales were confirmed, what is in flight, mismatches.
create or replace function admin_compliance_summary(p_from timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with paid as (
    select t.id, t.rail_provider,
           exists (select 1 from rail_events e where e.transaction_id = t.id and e.signature_ok and e.applied) as confirmed
    from transactions t where t.created_at >= p_from and t.status in ('SUCCESS', 'SETTLED')
  )
  select jsonb_build_object(
    'total', (select count(*) from paid),
    'provider_confirmed', (select count(*) from paid where confirmed),
    'simulated', (select count(*) from paid where not confirmed and rail_provider is null),
    'awaiting_callback', (select count(*) from paid where not confirmed and rail_provider is not null),
    'in_flight', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0), 'oldest', min(processing_at)) from transactions where status = 'PROCESSING'),
    'mismatches', (select count(*) from watchdog_events where event_type = 'SETTLEMENT_MISMATCH' and created_at >= p_from)
  );
$$;

-- The sales that need a human: paid with a provider but never confirmed by its callback, an amount that differs from the quote,
-- or a payment stuck in flight for over an hour.
create or replace function admin_compliance_exceptions(p_from timestamptz, p_limit integer default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', t.id, 'created_at', t.created_at, 'business', m.business_name, 'terminal', m.terminal_id,
             'amount', t.amount, 'settled_amount', t.settled_amount, 'provider', t.rail_provider,
             'reason', case
               when t.status = 'PROCESSING' then 'STUCK_IN_FLIGHT'
               when t.settled_amount is not null and t.settled_amount <> t.amount then 'AMOUNT_DIFFERS'
               else 'NO_PROVIDER_CONFIRMATION' end) as r
    from transactions t join merchants m on m.id = t.merchant_id
    where t.created_at >= p_from and (
      (t.status = 'PROCESSING' and t.processing_at < now() - interval '60 minutes')
      or (t.status in ('SUCCESS', 'SETTLED') and t.settled_amount is not null and t.settled_amount <> t.amount)
      or (t.status in ('SUCCESS', 'SETTLED') and t.rail_provider is not null
          and not exists (select 1 from rail_events e where e.transaction_id = t.id and e.signature_ok and e.applied))
    )
    order by t.created_at desc
    limit greatest(1, least(p_limit, 200))
  ) x;
$$;

-- Find paid sales by (the start of) their id, a terminal id or a business name, newest first, with keyset paging for exports.
create or replace function admin_find_sales(p_q text, p_from timestamptz, p_to timestamptz, p_limit integer default 25, p_before timestamptz default null, p_before_id uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r->>'created_at' desc, r->>'id' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', t.id, 'merchant_id', t.merchant_id, 'created_at', t.created_at, 'processing_at', t.processing_at, 'settled_at', t.settled_at,
      'amount', t.amount, 'settled_amount', t.settled_amount, 'rail', t.rail, 'rail_provider', t.rail_provider,
      'settlement_method', t.settlement_method, 'routed_bank', t.routed_bank, 'routed_wallet', t.routed_wallet,
      'source', t.source, 'status', t.status, 'base_fee', t.base_fee, 'vat_fee', t.vat_fee,
      'net_merchant_settlement', t.net_merchant_settlement, 'payer_app', t.payer_app,
      'business', m.business_name, 'terminal', m.terminal_id,
      'confirmed', exists (select 1 from rail_events e where e.transaction_id = t.id and e.signature_ok and e.applied),
      'confirmed_at', (select max(e.received_at) from rail_events e where e.transaction_id = t.id and e.signature_ok and e.applied)
    ) as r
    from transactions t join merchants m on m.id = t.merchant_id
    where t.status in ('SUCCESS', 'SETTLED')
      and t.created_at >= p_from and t.created_at < p_to
      and (p_before is null or (t.created_at, t.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      and (coalesce(p_q, '') = ''
           or t.id::text like lower(p_q) || '%'
           or m.terminal_id ilike p_q || '%'
           or m.business_name ilike '%' || p_q || '%')
    order by t.created_at desc, t.id desc
    limit greatest(1, least(p_limit, 1000))
  ) x;
$$;

revoke execute on function admin_day_stats(timestamptz) from public, anon, authenticated;
revoke execute on function admin_node_fees(timestamptz, integer) from public, anon, authenticated;
revoke execute on function admin_compliance_summary(timestamptz) from public, anon, authenticated;
revoke execute on function admin_compliance_exceptions(timestamptz, integer) from public, anon, authenticated;
revoke execute on function admin_find_sales(text, timestamptz, timestamptz, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function admin_day_stats(timestamptz) to service_role;
grant execute on function admin_node_fees(timestamptz, integer) to service_role;
grant execute on function admin_compliance_summary(timestamptz) to service_role;
grant execute on function admin_compliance_exceptions(timestamptz, integer) to service_role;
grant execute on function admin_find_sales(text, timestamptz, timestamptz, integer, timestamptz, uuid) to service_role;

-- Counts for the network panel: how many businesses, stands, app phones, ride companies, drivers and checkouts there are.
create or replace function admin_network_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'merchants', (select count(*) from merchants where kind = 'MERCHANT'),
    'shop_qr_stands', (select count(*) from merchants where kind = 'MERCHANT' and static_qr_enabled is not false),
    'app_devices', (select count(*) from merchant_staff where device_id_hash is not null and active),
    'by_role', coalesce((select jsonb_object_agg(role, n) from (select role, count(*) as n from merchant_staff where device_id_hash is not null and active group by role) r), '{}'::jsonb),
    'ride_partners', (select count(*) from ride_partners where active),
    'ride_drivers_24h', (select count(distinct (partner_id, driver_id)) from ride_sessions where created_at >= now() - interval '24 hours'),
    'ride_checkouts_24h', (select count(*) from ride_sessions where created_at >= now() - interval '24 hours')
  );
$$;
revoke execute on function admin_network_counts() from public, anon, authenticated;
grant execute on function admin_network_counts() to service_role;
notify pgrst, 'reload schema';
