-- 2Pay V2.7: business categories, individual drivers linked to ride-hailing companies, and the tax estimate.
-- SAFE TO RE-RUN (idempotent). Run AFTER v2_6.sql and BEFORE deploying V2.7.

-- ------------------------------------------------------------------ business categories
-- Registration now offers: Fuel Station (Fuel), Supermarket, Service (restaurants, cafes and the like), Ride Service (Ride) and Merchant
-- (the general one). `Retail` stays valid for businesses registered before V2.7.
alter table merchants drop constraint if exists merchants_category_check;
alter table merchants add constraint merchants_category_check check (category in ('Fuel', 'Retail', 'Supermarket', 'Service', 'Ride', 'Merchant'));

-- ------------------------------------------------------------------ individual drivers
-- A driver who registers as "Ride Service" is a record of kind DRIVER: their own accounts, their own earnings. Fayda is not required of them.
alter table merchants drop constraint if exists merchants_kind_chk;
alter table merchants add constraint merchants_kind_chk check (kind in ('MERCHANT', 'RIDE_PARTNER', 'DRIVER'));

-- A driver can be linked to several ride-hailing companies at once: one row per (company, the company's own id for the driver).
create table if not exists ride_driver_links (
  id           uuid primary key default gen_random_uuid(),
  partner_id   uuid not null references ride_partners(id),
  driver_ref   text not null,                       -- the company's own id for this driver
  merchant_id  uuid references merchants(id),       -- the driver's 2Pay record (empty until they register)
  phone        text,                                -- the number the company gave, used to invite or match the driver
  status       text not null default 'PENDING' check (status in ('INVITED', 'PENDING', 'ACTIVE', 'REVOKED')),
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz,
  revoked_at   timestamptz,
  unique (partner_id, driver_ref)
);
create index if not exists ride_driver_links_merchant_idx on ride_driver_links (merchant_id) where merchant_id is not null;
create index if not exists ride_driver_links_phone_idx on ride_driver_links (phone) where phone is not null;

-- One-time codes a company hands a driver; the driver types it into 2Pay to confirm the link. Only a hash is kept.
create table if not exists ride_link_codes (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references ride_partners(id),
  driver_ref  text not null,
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table ride_driver_links enable row level security;
alter table ride_link_codes   enable row level security;
revoke all on ride_driver_links, ride_link_codes from anon, authenticated;
grant all on ride_driver_links, ride_link_codes to service_role;

-- Whether a company may still send the payout accounts itself. Off by default: a driver's accounts are the driver's own.
alter table ride_partners add column if not exists allow_partner_accounts boolean not null default false;

-- A ride for a linked driver names the driver's 2Pay record; the accounts are the driver's own and are read when the pay node is made.
alter table ride_sessions alter column accounts drop not null;
alter table ride_sessions add column if not exists driver_merchant_id uuid references merchants(id);
create index if not exists ride_sessions_driver_idx on ride_sessions (driver_merchant_id, created_at desc) where driver_merchant_id is not null;

-- ------------------------------------------------------------------ the tax estimate
-- One row of settings (the rates). It starts empty: the application supplies its own defaults, clearly marked as not yet confirmed, until
-- an admin sets the rates and confirms them.
create table if not exists tax_settings (
  id           smallint primary key default 1 check (id = 1),
  rules        jsonb not null default '{}'::jsonb,
  version      integer not null default 1,
  confirmed_by text,
  confirmed_at timestamptz,
  updated_at   timestamptz not null default now()
);
insert into tax_settings (id) values (1) on conflict (id) do nothing;
alter table tax_settings enable row level security;
revoke all on tax_settings from anon, authenticated;
grant all on tax_settings to service_role;

-- A business's digital volume by month (Addis Ababa months): sales, the bill total, tips, and refunds paid back.
create or replace function merchant_tax_volume(p_merchant uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with paid as (
    select to_char(date_trunc('month', t.created_at at time zone 'Africa/Addis_Ababa'), 'YYYY-MM') as m, t.amount, t.tip_amount
    from transactions t
    where t.merchant_id = p_merchant and t.status in ('SUCCESS', 'SETTLED') and t.created_at >= p_from and t.created_at < p_to
  ),
  refunded as (
    select to_char(date_trunc('month', t.created_at at time zone 'Africa/Addis_Ababa'), 'YYYY-MM') as m, r.amount
    from refund_requests r join transactions t on t.id = r.transaction_id
    where r.merchant_id = p_merchant and r.status = 'REFUNDED' and t.created_at >= p_from and t.created_at < p_to
  ),
  months as (select m from paid union select m from refunded)
  select coalesce(jsonb_agg(jsonb_build_object(
    'month', mo.m,
    'sales', (select count(*) from paid p where p.m = mo.m),
    'gross', coalesce((select sum(p.amount) from paid p where p.m = mo.m), 0),
    'tips', coalesce((select sum(p.tip_amount) from paid p where p.m = mo.m), 0),
    'refunded', coalesce((select sum(r.amount) from refunded r where r.m = mo.m), 0)
  ) order by mo.m), '[]'::jsonb) from months mo;
$$;
revoke execute on function merchant_tax_volume(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function merchant_tax_volume(uuid, timestamptz, timestamptz) to service_role;

-- The admin network counts now also count drivers.
create or replace function admin_network_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'merchants', (select count(*) from merchants where kind = 'MERCHANT'),
    'drivers', (select count(*) from merchants where kind = 'DRIVER'),
    'shop_qr_stands', (select count(*) from merchants where kind = 'MERCHANT' and static_qr_enabled is not false),
    'app_devices', (select count(*) from merchant_staff where device_id_hash is not null and active),
    'by_role', coalesce((select jsonb_object_agg(role, n) from (select role, count(*) as n from merchant_staff where device_id_hash is not null and active group by role) r), '{}'::jsonb),
    'ride_partners', (select count(*) from ride_partners where active),
    'linked_drivers', (select count(distinct merchant_id) from ride_driver_links where status = 'ACTIVE'),
    'ride_drivers_24h', (select count(distinct coalesce(driver_merchant_id::text, partner_id::text || ':' || driver_id)) from ride_sessions where created_at >= now() - interval '24 hours'),
    'ride_checkouts_24h', (select count(*) from ride_sessions where created_at >= now() - interval '24 hours')
  );
$$;
revoke execute on function admin_network_counts() from public, anon, authenticated;
grant execute on function admin_network_counts() to service_role;

notify pgrst, 'reload schema';
