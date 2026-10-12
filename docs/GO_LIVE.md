# Go-live checklist

Work top to bottom. Each section says what turning it on does, so nothing is switched on by surprise.

## 1. Database (Supabase SQL editor, in this order, all idempotent)

1. `supabase/pilot_reconcile.sql`
2. `supabase/multi_rail_routing.sql`
3. `supabase/merchant_registration.sql`
4. `supabase/rails_live.sql` : live-payment columns, `PROCESSING` state, raw-callback audit table. Safe before deploying.
5. `supabase/v2_1.sql` : **V2.1. Run this BEFORE pushing the V2.1 code.** Adds business-details (KYC) columns, shop-QR flag, payer
   contacts (kept apart from the public sales table), staff, refund requests, audit log, rate limiting, error log and routing history.
6. **Deploy this release**, then `supabase/lockdown_reads.sql`. It removes all browser access to your data with the public key and
   makes "mark a sale paid" server-only. **Do not run it before deploying**: older pages read the database directly and would break.

(`supabase/all_migrations.sql` bundles steps 1-5, without the lockdown.)

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
| `KYC_REQUIRED_FOR_LIVE` | default `true`: in live mode a merchant can only take payments after an admin approves their business details |
| `RAIL_ROUTING`, `RAIL_APP_LINKS` | smart routing across providers; "open my bank app" links (both optional) |
| `STATIC_QR_MAX_ETB` | cap for amounts typed on a shop QR page (default 20000) |
| `RETENTION_PURGE_DAYS` | turns on the daily deletion of old unpaid links and payer phone numbers; leave unset until counsel agrees the period |
| `NEXT_PUBLIC_LEGAL_CONTACT` | contact shown on the Terms and Privacy pages |

Receipts by SMS and one-time codes both use `SMS_WEBHOOK_URL`. Without it, receipts are skipped (the sale is unaffected).

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
- [ ] A native Amharic speaker has read every screen (the translations were written by an AI, not reviewed by a person).
- [ ] An Ethiopian lawyer has reviewed `/terms` and `/privacy` (the text is a plain-language draft, not legal advice) and the
      National Bank's directives on payment-system operators and data handling have been checked.
- [ ] One merchant submitted business details, an admin approved them, and a live payment then succeeded for that merchant only.
- [ ] A refund request was raised, approved in the admin hub, and actually returned to the customer through your provider
      (2Pay records and tracks refunds; it does not move the money back itself).
- [ ] An independent penetration test has been done (not something the code can certify for itself).

## 4. Android app

- Built from `android/` with `scripts/release-android.ps1` (runs the tap-protocol tests, signs, writes `public/downloads/latest.json`).
  Commit `public/downloads` and push; `/download` then offers the new APK and installed apps show an update banner.
  It is a native shell around this site, so web releases reach phones instantly; only native changes need a new APK.
- Tap-to-pay needs a phone with NFC **and** Host Card Emulation, NFC switched on, and the screen on during a sale (the app holds it on).
- Test on real hardware before launch: Android to Android, and Android to iPhone XS or newer, on each handset model your merchants use.
- For the Play Store, build an Android App Bundle (`gradlew bundleRelease`) and enrol in Play App Signing.

## 5. Known limits (be honest with stakeholders)

- Tap-to-pay carries a **link**, not card data: the payer's phone opens the pay page and approves with their own bank or wallet.
  It is not EMV contactless and does not need card-scheme certification, but it does need a data connection on the payer's phone.
- Smart routing exists and is tested, but only **one** provider adapter (Arifpay) is built, so there is nothing to route between yet.
  Adding a second provider is one adapter file plus a `RAIL_ROUTING` entry (see `docs/RAIL_INTEGRATION.md`).
- Wallet payouts to merchants (as opposed to collecting from wallets) are not built.
- Refunds are a request-and-approve workflow with an audit trail; the money is returned through your provider, not by 2Pay.
- The EMVCo QR encoder is groundwork: it needs the national scheme's merchant template and is not wired to settlement.
- Rate limiting is database-backed and covers sign-in, payment and shop-QR routes; add an edge/WAF layer before a large public launch.
- The enforced Content-Security-Policy still allows inline scripts that Next.js needs; a stricter nonce-based policy is running in
  report-only mode so you can see violations before tightening.
- Nine build-time dependency advisories remain (Tailwind/PostCSS chains). They do not run in production; fixing them means a
  major upgrade of Next.js and Tailwind, which should be its own change.
- No iPhone merchant app, App Clip, USSD or push notifications yet: each needs an outside party (see `docs/ROADMAP_V2_1.md`).
