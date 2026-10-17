# Go-live checklist

Work top to bottom. Each section says what turning it on does, so nothing is switched on by surprise.

## 1. Database (Supabase SQL editor, in this order, all idempotent)

1. `supabase/pilot_reconcile.sql`
2. `supabase/multi_rail_routing.sql`
3. `supabase/merchant_registration.sql`
4. `supabase/rails_live.sql` : live-payment columns, `PROCESSING` state, raw-callback audit table. Safe before deploying.
5. `supabase/v2_1.sql` : **V2.1. Run this BEFORE pushing the V2.1 code.** Adds business-details (KYC) columns, shop-QR flag, payer
   contacts (kept apart from the public sales table), staff, refund requests, audit log, rate limiting, error log and routing history.
6. `supabase/v2_2.sql` : **V2.2 (team members and tips). Run this BEFORE pushing the V2.2 code.** Adds team numbers, activation links (stored as hashes), phone binding, a waiter id and a tip amount on every sale. `/api/health` reports `"schema":"outdated"` and names this file until it has run.
7. `supabase/v2_3.sql` : **V2.3 (settlement vault and routing hub). Run this BEFORE pushing the V2.3 code.** Adds the owner step-up purpose, a tamper-evident log of every change to the receiving accounts, and the customer's chosen app on each sale.
8. `supabase/v2_4.sql` : **V2.4 (security vault, managers, national ID, encryption). Run this BEFORE pushing the V2.4 code.** Adds the MANAGER role, the security-key and lock columns, the national ID (Fayda) columns, and the last-four column on the settlement log.
9. `supabase/v2_5.sql` : **V2.5 (tiered fees with VAT in the ledger, Fayda FAN e-KYC, ride-hailing partners). Run this BEFORE pushing the V2.5 code.** Adds `base_fee`, `vat_fee` and `net_merchant_settlement` to every sale (and widens `fee_ft`), the Fayda FAN columns and request table, and the ride partner and ride session tables.
10. `supabase/v2_6.sql` : **V2.6 (ride companies kept apart from merchants, the AI event outbox, and server-side admin totals). Run this BEFORE pushing the V2.6 code.** Adds `merchants.kind`, ride company contact columns, the AI outbox and score tables, and the database functions the admin hub now uses for its totals, searches and exports. The admin hub will show an error until it has run.
11. `supabase/v2_7.sql` : **V2.7 (individual drivers, registration categories, tax estimate). Run this BEFORE pushing the V2.7 code.** Adds the driver kind and the new categories, the driver-to-company links and one-time link codes, the per-company "legacy accounts" switch, the tax rules table and the tax-volume function, and re-creates `admin_network_counts` with driver counts. Registration and the ride endpoints fail until it has run.
12. **Deploy this release**, then `supabase/lockdown_reads.sql`. (If you ever re-run `all_migrations.sql` on a live system, run the lockdown again afterwards.) It removes all browser access to your data with the public key and
   makes "mark a sale paid" server-only. **Do not run it before deploying**: older pages read the database directly and would break.

(`supabase/all_migrations.sql` bundles steps 1-10, without the lockdown.)

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
| `RAIL_APP_LINKS` (object form), `ETHQR_TEMPLATE` | open the customer's own app, pre-filled (formats come from each bank/wallet and EthSwitch; see `docs/VAULT_NODE_HUB.md`) |
| `DATA_ENCRYPTION_KEY` | **V2.4.** 32 random bytes, base64 (`openssl rand -base64 32`). Turns on AES-256-GCM encryption of account numbers, TINs and national-ID names in the database. Keep a copy in a password manager: without it those fields cannot be read. Once set, never remove it. |
| `DATA_ENCRYPTION_KEY_PREV` | only while rotating: put the old key here, set a new `DATA_ENCRYPTION_KEY`, and rows are re-sealed under the new key as they are saved |
| `FAYDA_ISSUER`, `FAYDA_CLIENT_ID`, `FAYDA_PRIVATE_JWK` | national ID (Fayda) sign-in. Supplied by the National ID Program when your organisation is onboarded; see `docs/SECURITY_V2_4.md` |
| `FAYDA_REDIRECT_URI`, `FAYDA_SCOPES`, `FAYDA_ACR_VALUES` | optional Fayda settings (default redirect is `PUBLIC_BASE_URL/api/fayda/callback`) |
| `KYC_REQUIRE_FAYDA` | **V2.5: in live mode the owner's Fayda verification is MANDATORY by default** (no variable needed). Set `KYC_REQUIRE_FAYDA=false` only to relax it deliberately, for example while the Fayda connection is still being arranged |
| `FAYDA_EKYC_URL`, `FAYDA_EKYC_KEY` | the Fayda e-KYC gateway for the FAN + one-time-code check (from the National ID Program; the request format is theirs, see `docs/RIDE_AND_PRICING_V2_5.md`) |
| `FAYDA_SANDBOX_MODE=true` | development only: any 16-digit FAN, code `123456`. **Ignored when `RAIL_MODE=live`**, so real money can never be unlocked with it |
| `RIDE_SESSION_TTL_MINUTES` | how long a ride checkout link stays usable (default 30) |
| `DEPLOY_ROLE`, `NEXT_PUBLIC_API_BASE`, `UI_ORIGINS`, `COOKIE_DOMAIN`, `API_BASE_URL`, `SUPABASE_URL` | **V2.6, for keeping transaction data in the country** (screens on Vercel, API and database in Ethiopia). Leave all unset to run as today. See `docs/DATA_RESIDENCY_AND_AI.md`. |
| `AI_EVENT_LEVEL`, `AI_EVENT_SINK_URL`, `AI_EVENT_SECRET`, `AI_PSEUDONYM_KEY` | **V2.6, the AI layer.** Off unless all are set. Needs a legal ruling before use. Run `/api/cron/ai-events` (with `CRON_SECRET`) every minute from the core's scheduler as a safety net. |
| `NEXT_PUBLIC_RAIL_LOGO_CDN` | optional: an `https://` URL containing `{slug}` for bank/wallet logos you are licensed to use. Local logos go in `public/assets/rails/` |
| `ETS_BANK_CODES` | the EthSwitch bank codes used by "transfer to other bank" links, e.g. `{"Awash Bank":"<code>"}`. Supplied by EthSwitch |
| `ALLOW_BROWSER_NODES` | leave unset: waiters must use the Android app (set `true` only for testing) |
| `NEXT_PUBLIC_LEGAL_CONTACT` | contact shown on the Terms and Privacy pages |

Receipts by SMS and one-time codes both use `SMS_WEBHOOK_URL`. Without it, receipts are skipped (the sale is unaffected).

## 3. Before real money

- [ ] Arifpay (or your provider) has confirmed: production session path, callback payload + signing, bank codes, payout model.
- [ ] A full **sandbox** payment was made end to end and `rail_events` shows the real callback; `parseWebhook` matches it.
- [ ] The custody question is settled with counsel and the National Bank: without beneficiary splitting, collected funds sit in your
      provider merchant account.
- [ ] SMS gateway delivers a code to a real phone; one merchant registered and signed in with `AUTH_ENFORCED=true`.
- [ ] **Team nodes:** add a waiter, open the activation link on a second phone, confirm the code, take a sale, pay it with a 10 % tip, and check the cashier's feed names the waiter and shows the tip, the waiter's own ledger shows only theirs, and the owner's Team tab shows revenue and tips per person. Then remove the waiter and confirm their phone can no longer start a sale. See `docs/TEAM_NODE_TIPS.md`.
- [ ] **Settlement vault:** with sign-in enforced, remove or switch a receiving account as the owner: the app asks for a code, the code arrives ONLY on the registered owner phone, the change goes through, and an SMS tells the owner. A cashier or waiter cannot even request the code.
- [ ] **Security key + manager (V2.4):** as the owner, set a 6-digit security key (Settings > Receiving accounts); add or remove an account: the app asks for the key AND a code that arrives on the owner's phone. Add a manager (Team tab), have them set their own key, and confirm they can make the same change with their own key and phone, and that a cashier and a waiter cannot. Enter the wrong key 5 times and confirm the 15-minute lock and the SMS to the owner.
- [ ] **Encryption (V2.4):** `DATA_ENCRYPTION_KEY` is set and backed up. Re-save each existing merchant's receiving accounts and business details once (rows saved before the key was set stay readable but unencrypted until they are saved again). Spot-check in Supabase that `saved_banks` shows `enc:v1:...` for the account number.
- [ ] **Forgotten security key (self-service):** on a test business, press "Forgot your key?" in the "Confirm it's you" box: a code arrives on the registered phone (and, for an owner verified with Fayda, a Fayda check follows), a new key is chosen, the owner is texted, and changing an account still needs the new key and a fresh code. 2Pay staff hold and reset nothing.
- [ ] **Ride-hailing company registration (V2.6):** admin hub > Ride partners > Register: the company is not added to the merchant list, and nobody can sign in as it. Its rides are recorded under its own record.
- [ ] **Admin hub at scale (V2.6):** totals, the node list, the Fayda tracker (paged, searchable), and the NBE compliance tab (summary, exceptions, find-a-sale, CSV export) all load quickly and stay small; export a date range and open the file.
- [ ] **Fees (V2.5):** make a 50, a 300, a 1,000, a 7,500 and a 25,000 ETB test sale and check in the merchant's Sales view and the admin hub's fee panel that the total deducted is 0.53, 0.98, 1.45, 2.33 and 2.89 ETB (fee + 15% VAT on the fee, each to the nearest santim; formula in `docs/RIDE_AND_PRICING_V2_5.md` section 4), and that the merchant receives the rest.
- [ ] **Fayda is mandatory in live mode (V2.5):** with `RAIL_MODE=live` and no `KYC_REQUIRE_FAYDA` set, an owner who has not verified Fayda gets `FAYDA_REQUIRED` when starting a sale. Verify one owner (Profile > National ID) and confirm sales then work. The gateway details (`FAYDA_EKYC_*`) must be in place first, or no owner can verify.
- [ ] **Ride-hailing (V2.5):** in the admin hub > Ride partners, create a partner attached to its merchant and give the API key to the partner over a secure channel (it is shown once). Make a test ride with `POST /api/v1/integrations/ride-hailing/session`, open `twopay://checkout?token=...` on a phone with the 2.5.0 app, tap a passenger phone, and check the driver's accounts show on the passenger screen and that the payment reaches the DRIVER. See `docs/RIDE_AND_PRICING_V2_5.md`.
- [ ] **Registration categories (V2.7):** register a test account and check the Category Selection is required (Fuel Station, Supermarket, Service, Ride Service, Merchant) and the button stays off until one is chosen.
- [ ] **Individual drivers (V2.7):** register a driver with "Ride Service" (no TIN, licence or national ID is asked), add a wallet under Get paid, then from a test company key send `POST .../ride-hailing/drivers` with the driver's phone, accept the request under Rides, and start a ride with `POST .../ride-hailing/session` (no account details). With 2Pay open on the driver's phone the fare must appear by itself. Link the same driver to a second test company with a link code, and unlink one: the other keeps working. See `docs/DRIVERS_AND_TAX_V2_7.md`.
- [ ] **Existing ride companies (V2.7):** a company set up before V2.7 that sends driver accounts with each ride is refused (`PARTNER_ACCOUNTS_NOT_ALLOWED`) until you either move its drivers to linking or switch on "Allow legacy accounts" for it in the admin hub > Ride partners. The two demo companies should be disabled, not kept.
- [ ] **Tax estimate (V2.7):** admin hub > Tax rules: have a tax adviser check the rates against current Ethiopian law, edit them if needed, then confirm the version with their name. Until then merchants see a warning that the rates are unchecked. Open a verified business's Tax tab and compare one month with its Sales.
- [ ] **Waiter app:** install the APK on a real phone, open a waiter's link from SMS / WhatsApp: it opens inside the app, activates, and the phone can tap to pay. Opening the same kind of link in a browser must send the waiter to the app, not activate them.
- [ ] `https://<site>/.well-known/assetlinks.json` loads (it makes https links open in the app).
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
- The enforced Content-Security-Policy blocks every other site but still allows inline scripts that Next.js needs; a nonce-based policy
  that removes `unsafe-inline` is the next hardening step.
- Nine build-time dependency advisories remain (Tailwind/PostCSS chains). They do not run in production; fixing them means a
  major upgrade of Next.js and Tailwind, which should be its own change.
- **Bank and wallet logos** are not shipped: official marks come from each institution. Until a logo is registered (`public/assets/rails/README.md`), the hub shows a coloured initials badge.
- **Ride-hailing:** the driver's payout accounts come from the partner for each ride, so a partner whose key is stolen could redirect payouts. Keys are hashed, can be rotated or switched off in the admin hub, and every ride is audited; ask partners to keep the key server-side only, and consider registering each driver's accounts with 2Pay in advance as a later hardening step.
- No iPhone merchant app, App Clip, USSD or push notifications yet: each needs an outside party (see `docs/ROADMAP_V2_1.md`).
