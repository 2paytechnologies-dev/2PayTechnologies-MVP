-- 2Pay production lockdown. SAFE TO RE-RUN (idempotent).
--
-- !! RUN THIS ONLY AFTER the release that reads everything through /api/* is DEPLOYED. !!
-- Releases before it read `transactions` and `watchdog_events` straight from the browser with the public anon key
-- and call the authorize function from the anon role; this script removes all of that, so those older pages break.
--
-- After it runs, the public anon key can do NOTHING with your data:
--   * it cannot read transactions, watchdog events, ad data, OTPs or rail events;
--   * it cannot mark a sale paid (authorize_transaction_v2 is service-role only), which in live-rail mode would
--     otherwise let anyone skip paying;
--   * every read and write goes through server routes that check the session and ownership.

-- Transactions: no direct access for the public roles.
drop policy if exists "transactions readable" on transactions;
drop policy if exists "transactions create" on transactions;
revoke all on transactions from anon, authenticated;

-- Watchdog events (compliance data): server-only.
drop policy if exists "watchdog readable" on watchdog_events;
revoke all on watchdog_events from anon, authenticated;

-- Merchants: no public access at all. The server returns only the public fields it chooses to.
drop policy if exists "merchants readable" on merchants;
revoke all on merchants from anon, authenticated;

-- Payment state transitions are server-only.
revoke execute on function authorize_transaction_v2(uuid, text) from public, anon, authenticated;
revoke execute on function open_transaction(uuid)               from public, anon, authenticated;
grant  execute on function authorize_transaction_v2(uuid, text) to service_role;
grant  execute on function open_transaction(uuid)               to service_role;

-- Realtime no longer feeds the app; stop publishing row changes for these tables.
do $$ begin
  alter publication supabase_realtime drop table transactions;
exception when undefined_object then null; when others then null; end $$;
do $$ begin
  alter publication supabase_realtime drop table watchdog_events;
exception when undefined_object then null; when others then null; end $$;

notify pgrst, 'reload schema';
