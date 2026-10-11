# Go-live checklist

Work top to bottom. Each section says what turning it on does, so nothing is switched on by surprise.

## 1. Database (Supabase SQL editor, in this order, all idempotent)

1. `supabase/pilot_reconcile.sql`
2. `supabase/multi_rail_routing.sql`
3. `supabase/merchant_registration.sql`
4. `supabase/rails_live.sql` : live-payment columns, `PROCESSING` state, raw-callback audit table. Safe before deploying.
5. **Deploy this release**, then `supabase/lockdown_reads.sql`. It removes all browser access to your data with the public key and
   makes "mark a sale paid" server-only. **Do not run it before deploying**: older pages read the database directly and would break.

(`supabase/all_migrations.sql` bundles steps 1-3.)

## 2. Environment variables (Vercel, then redeploy)

| Variable | Purpose |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | server-only database access |
| `SESSION_SECRET` | 32+ random chars; signs sessions and OTP hashes |
| `AUTH_ENFORCED=true` | require sign-in; merchants see only their own data; admin pages need an admin phone |
| `ADMIN_PHONES` | phones allowed into the admin hub |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | SMS gateway for one-time codes (required when enforcing) |
| `RAIL_PROVIDER`, `PUBLIC_BASE_URL`, `ARIFPAY_*` | see `docs/RAIL_INTEGRATION.md` |
| `RAIL_MODE=live` | **last**: payers are sent to the rail and only callbacks mark sales paid |
| `CRON_SECRET` | enables the daily stuck-payment check (`vercel.json`) |
| `AML_SAR_THRESHOLD_ETB`, `WATCHDOG_INGEST_SECRET` | compliance rules and feed |

## 3. Before real money

- [ ] Arifpay (or your provider) has confirmed: production session path, callback payload + signing, bank codes, payout model.
- [ ] A full **sandbox** payment was made end to end and `rail_events` shows the real callback; `parseWebhook` matches it.
- [ ] The custody question is settled with counsel and the National Bank: without beneficiary splitting, collected funds sit in your
      provider merchant account.
- [ ] SMS gateway delivers a code to a real phone; one merchant registered and signed in with `AUTH_ENFORCED=true`.
- [ ] An admin phone can open `/dashboard/admin`; a normal merchant is redirected away; one merchant cannot read another's
      transactions (`/api/transactions?merchant_id=<other>` returns 403).
- [ ] With `lockdown_reads.sql` applied, `GET <supabase-url>/rest/v1/transactions` using the public key returns an error, not data.
- [ ] `ADMIN_PHONES` and merchant payout accounts reviewed; test merchants and test transactions removed.
- [ ] Back up `~/.2pay-android` (Android signing key). Losing it means you can never update the app under its identity.

## 4. Android app

- Built from `android/` (`gradlew assembleRelease`, signed with the key above). It is a native shell around this site, so web
  releases reach phones instantly; only native changes need a new APK.
- Tap-to-pay needs a phone with NFC **and** Host Card Emulation, NFC switched on, and the screen on during a sale (the app holds it on).
- Test on real hardware before launch: Android to Android, and Android to iPhone XS or newer, on each handset model your merchants use.
- For the Play Store, build an Android App Bundle (`gradlew bundleRelease`) and enrol in Play App Signing.

## 5. Known limits (be honest with stakeholders)

- Tap-to-pay carries a **link**, not card data: the payer's phone opens the pay page and approves with their own bank or wallet.
  It is not EMV contactless and does not need card-scheme certification, but it does need a data connection on the payer's phone.
- One active rail provider per deployment. Per-institution routing across providers is not built yet.
- Wallet payouts to merchants (as opposed to collecting from wallets) are not built.
- No refunds or reversals flow yet.
- No rate limiting beyond OTP request limits; add an edge/WAF rule or a rate-limit service before public launch.
- No strict Content-Security-Policy yet (baseline security headers only).
