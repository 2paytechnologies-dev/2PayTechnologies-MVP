-- 2Pay V2.4: security key (vault) + managers, national-ID (Fayda) verification, encrypted-at-rest support.
-- SAFE TO RE-RUN (idempotent). Run AFTER v2_3.sql and BEFORE deploying V2.4.

-- ------------------------------------------------------------------ managers
-- A manager is a team member the owner appoints to manage payment accounts (with their own security key and phone code).
alter table merchant_staff drop constraint if exists merchant_staff_role_check;
alter table merchant_staff add constraint merchant_staff_role_check check (role in ('CASHIER', 'WAITER', 'MANAGER'));

-- ------------------------------------------------------------------ the security key
-- A 6-digit key per approver (the owner on `merchants`, each manager on `merchant_staff`). Only a memory-hard scrypt hash is
-- stored, never the key. Five wrong keys lock it for 15 minutes (counted and enforced by the server).
alter table merchants      add column if not exists vault_pin_hash    text;
alter table merchants      add column if not exists vault_pin_set_at  timestamptz;
alter table merchants      add column if not exists vault_failed      integer not null default 0;
alter table merchants      add column if not exists vault_locked_until timestamptz;
alter table merchant_staff add column if not exists vault_pin_hash    text;
alter table merchant_staff add column if not exists vault_pin_set_at  timestamptz;
alter table merchant_staff add column if not exists vault_failed      integer not null default 0;
alter table merchant_staff add column if not exists vault_locked_until timestamptz;

-- ------------------------------------------------------------------ national ID (Fayda) verification
-- What we keep after a person proves who they are with Fayda: that it happened, a keyed hash of their national-ID subject
-- (so the same person cannot be passed off twice, without storing the number), and their name as Fayda gave it (encrypted
-- by the application). The ID number, photo and birth date are NOT stored.
alter table merchants      add column if not exists fayda_verified_at  timestamptz;
alter table merchants      add column if not exists fayda_subject_hash text;
alter table merchants      add column if not exists fayda_name         text;
alter table merchant_staff add column if not exists fayda_verified_at  timestamptz;
alter table merchant_staff add column if not exists fayda_subject_hash text;
alter table merchant_staff add column if not exists fayda_name         text;
create index if not exists merchants_fayda_subject_idx on merchants (fayda_subject_hash) where fayda_subject_hash is not null;

-- ------------------------------------------------------------------ the vault's history, with encrypted numbers
-- Account numbers may now be stored encrypted; the application keeps the last four digits beside them. The history trigger
-- uses those (and falls back to the number itself for rows written before encryption), so it never records a full number.
create or replace function settlement_mask(acct jsonb) returns jsonb
language sql immutable as $$
  select case when acct is null or jsonb_typeof(acct) <> 'object' then null
              else jsonb_build_object('id', acct->>'id', 'institution', acct->>'institution',
                                      'last4', coalesce(acct->>'last4', right(coalesce(acct->>'account_number', ''), 4))) end
$$;

-- Server-only, like every table that holds people or money. Nothing here is readable with the public key.
-- (Column privileges on `merchants` / `merchant_staff` for the public roles are owned by earlier migrations and
-- lockdown_reads.sql; they are deliberately not re-granted here.)
grant all on merchants      to service_role;
grant all on merchant_staff to service_role;

notify pgrst, 'reload schema';
