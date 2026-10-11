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
