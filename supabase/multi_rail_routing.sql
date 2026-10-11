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
