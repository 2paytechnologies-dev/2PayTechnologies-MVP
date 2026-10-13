-- 2Pay V2.3: settlement vault (step-up security + tamper-evident history) and the customer routing hub.
-- SAFE TO RE-RUN (idempotent). Run AFTER v2_2.sql and BEFORE deploying V2.3.

-- ------------------------------------------------------------------ step-up codes
-- Changing where money goes needs a fresh one-time code sent only to the business owner's registered phone.
-- Those codes live in the same server-only table as sign-in codes, with their own purpose.
alter table otp_challenges drop constraint if exists otp_challenges_purpose_check;
alter table otp_challenges add constraint otp_challenges_purpose_check check (purpose in ('register', 'login', 'stepup'));

-- ------------------------------------------------------------------ the vault's history
-- Every change to a receiving account (saved_banks, saved_wallets, active_bank, active_wallet) is written here by the
-- database itself, whoever made it, with account numbers reduced to their last four digits. Append-only: updates and
-- deletes are refused, so the record of "what was changed, when" cannot be rewritten afterwards.
create table if not exists settlement_change_log (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  changed_at  timestamptz not null default now(),
  before      jsonb not null,
  after       jsonb not null
);
create index if not exists settlement_change_log_merchant_idx on settlement_change_log (merchant_id, changed_at desc);

-- "Awash Bank ****6789" style summary of a saved account, never the full number.
create or replace function settlement_mask(acct jsonb) returns jsonb
language sql immutable as $$
  select case when acct is null or jsonb_typeof(acct) <> 'object' then null
              else jsonb_build_object('id', acct->>'id', 'institution', acct->>'institution',
                                      'last4', right(coalesce(acct->>'account_number', ''), 4)) end
$$;

create or replace function settlement_mask_list(accts jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(settlement_mask(a)), '[]'::jsonb) from jsonb_array_elements(coalesce(accts, '[]'::jsonb)) a
$$;

create or replace function log_settlement_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.saved_banks   is distinct from old.saved_banks
  or new.saved_wallets is distinct from old.saved_wallets
  or new.active_bank   is distinct from old.active_bank
  or new.active_wallet is distinct from old.active_wallet then
    insert into settlement_change_log (merchant_id, before, after) values (
      new.id,
      jsonb_build_object('banks', settlement_mask_list(old.saved_banks), 'wallets', settlement_mask_list(old.saved_wallets),
                         'active_bank', settlement_mask(old.active_bank), 'active_wallet', settlement_mask(old.active_wallet)),
      jsonb_build_object('banks', settlement_mask_list(new.saved_banks), 'wallets', settlement_mask_list(new.saved_wallets),
                         'active_bank', settlement_mask(new.active_bank), 'active_wallet', settlement_mask(new.active_wallet)));
  end if;
  return new;
end $$;

drop trigger if exists merchants_settlement_log on merchants;
create trigger merchants_settlement_log after update on merchants for each row execute function log_settlement_change();

create or replace function refuse_log_edit() returns trigger language plpgsql as $$
begin
  raise exception 'settlement_change_log is append-only';
end $$;
drop trigger if exists settlement_change_log_no_edit on settlement_change_log;
create trigger settlement_change_log_no_edit before update or delete on settlement_change_log for each row execute function refuse_log_edit();

-- Server-only, like every table that holds money details: RLS on, no policy, nothing for the public roles.
alter table settlement_change_log enable row level security;
revoke all on settlement_change_log from anon, authenticated;
grant select, insert on settlement_change_log to service_role;

-- The receiving-account columns themselves (saved_banks, saved_wallets, active_bank, active_wallet) are not readable or
-- writable with the public key: only the server's service role touches them, after checking session, tenant and role.
-- Public-role privileges on `merchants` are owned by multi_rail_routing.sql (column allow-list) and lockdown_reads.sql
-- (none), so they are deliberately NOT re-granted here: that would undo the lockdown.
grant all on merchants to service_role;

-- ------------------------------------------------------------------ the customer's own app
-- The wallet or bank app the customer chose on the pay page (their choice only; 2Pay cannot detect installed apps).
alter table transactions add column if not exists payer_app text;

notify pgrst, 'reload schema';
