-- 2Pay Technologies MVP schema. Run in the Supabase SQL editor.
-- PROTOTYPE security model: anon role may read everything and create PENDING
-- transactions; the ONLY way to flip a transaction to SUCCESS is the
-- authorize_transaction() function (single-use, TTL-enforced, server-clock latency).

create extension if not exists "pgcrypto";

create table if not exists merchants (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null,
  category      text not null check (category in ('Fuel', 'Retail')),
  terminal_id   text not null unique
);

create table if not exists transactions (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  token       uuid not null unique default gen_random_uuid(),
  amount      numeric(12,2) not null check (amount > 0),
  currency    text not null default 'ETB',
  status      text not null default 'PENDING' check (status in ('PENDING', 'SUCCESS', 'FAILED')),
  rail        text not null default 'EthioPay-IPS' check (rail in ('EthioPay-IPS', 'Telebirr', 'CBE Birr')),
  fee_ft      numeric(12,2) not null default 0,
  latency_ms  integer,
  viewed_at   timestamptz,                       -- customer opened /pay/[token]
  expires_at  timestamptz not null default (now() + interval '90 seconds'),
  created_at  timestamptz not null default now()
);

create index if not exists transactions_created_idx on transactions (created_at desc);

-- Row level security
alter table merchants    enable row level security;
alter table transactions enable row level security;

drop policy if exists "merchants readable"      on merchants;
drop policy if exists "transactions readable"   on transactions;
drop policy if exists "transactions create"     on transactions;
create policy "merchants readable"    on merchants    for select using (true);
create policy "transactions readable" on transactions for select using (true);
create policy "transactions create"   on transactions for insert
  with check (status = 'PENDING' and latency_ms is null);
-- No UPDATE policy: state transitions go through the functions below.

-- Customer opened the pay page: stamp viewed_at once, return the row if still valid.
create or replace function open_transaction(p_token uuid)
returns table (
  token uuid, amount numeric, currency text, status text, rail text,
  expires_at timestamptz, merchant_name text, merchant_category text, terminal_id text
)
language plpgsql security definer set search_path = public as $$
begin
  update transactions t set viewed_at = now()
   where t.token = p_token and t.viewed_at is null and t.status = 'PENDING' and t.expires_at > now();

  return query
    select t.token, t.amount, t.currency, t.status, t.rail, t.expires_at,
           m.business_name, m.category, m.terminal_id
      from transactions t join merchants m on m.id = t.merchant_id
     where t.token = p_token;
end $$;

-- Atomic single-use authorization. Latency = server time from page open to approval.
create or replace function authorize_transaction(p_token uuid, p_rail text default 'EthioPay-IPS')
returns transactions
language plpgsql security definer set search_path = public as $$
declare
  result transactions;
begin
  update transactions t
     set status = 'SUCCESS',
         rail = p_rail,
         latency_ms = greatest(1, (extract(epoch from (now() - coalesce(t.viewed_at, t.created_at))) * 1000)::int)
   where t.token = p_token and t.status = 'PENDING' and t.expires_at > now()
  returning * into result;

  if result.id is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED';
  end if;
  return result;
end $$;

grant execute on function open_transaction(uuid)              to anon, authenticated;
grant execute on function authorize_transaction(uuid, text)   to anon, authenticated;

-- Realtime
alter table transactions replica identity full;
do $$ begin
  alter publication supabase_realtime add table transactions;
exception when duplicate_object then null; end $$;

-- Seed
insert into merchants (business_name, category, terminal_id) values
  ('Total Energies Bole',  'Fuel',   'TRM-0001'),
  ('NOC Station Megenagna', 'Fuel',  'TRM-0002'),
  ('Shoa Supermarket',     'Retail', 'TRM-0003'),
  ('Wow Boutique Piassa',  'Retail', 'TRM-0004')
on conflict (terminal_id) do nothing;
