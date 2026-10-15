# V2.5: ride-hailing checkout, Fayda FAN e-KYC, bank logos, tiered fees with VAT

Run `supabase/v2_5.sql` **before** deploying (part of `all_migrations.sql`). 2Pay is still non-custodial.

---

## 1. Ride-hailing in-app checkout (Feres, RIDE, ...)

**The journey.** A trip ends in the partner's app. The partner's server tells 2Pay the fare and where the driver is paid; the driver's phone
switches to 2Pay with the fare already filled in and offers the tap and a QR; the passenger holds their phone to the driver's, sees the driver's
accounts, and pays from their own app. The money goes to the **driver's** account, not the partner's.

### Setting a partner up
Admin hub > **Ride partners** > name + the merchant the rides are recorded under > **Create partner**. The API key (`2pay_rk_...`) is shown **once**; only its
hash is kept. The same tab can switch a partner off at once (its key and every link it already gave out stop working) or rotate its key.

### The partner's API (server to server)
All calls carry `Authorization: Bearer <api key>`. Base: `/api/v1/integrations/ride-hailing/session`.

**Start a checkout:** `POST`
```json
{
  "partner_ride_id": "RIDE-1001",
  "driver_id": "drv-77",
  "driver_wallet_accounts": [
    { "rail": "TELEBIRR", "account_number": "0911223344" },
    { "rail": "CBE_BIRR", "account_number": "0922334455" },
    { "rail": "AWASH",    "account_number": "01320123456789" }
  ],
  "fare_amount": 250.00,
  "currency": "ETB"
}
```
Rails are bank/wallet codes (`TELEBIRR`, `CBE_BIRR`, `CBE`, `AWASH`, `AWASH_BIRR`, `DASHEN`, `AMOLE`, `MPESA`, ...) or the exact institution name. One to four accounts; wallet numbers are
Ethiopian mobile numbers, bank numbers 6 to 20 digits. The fare has at most two decimals, up to 1,000,000 ETB.

Reply (`201`, or `200` when the same ride is sent again):
```json
{
  "session_id": "...", "session_token": "<43 characters>", "expires_at": "...",
  "terminal_url": "https://<site>/terminal?session_token=...",
  "deep_link": "twopay://checkout?token=...",
  "android_intent": "intent://checkout?token=...#Intent;scheme=twopay;package=com.twopay.merchant;S.browser_fallback_url=...;end",
  "fare": { "amount": 250, "currency": "ETB" },
  "pricing": { "base_fee": 0.9084, "vat_fee": 0.1363, "total_fee": 1.0447, "net_driver_settlement": 248.9553 },
  "payout_accounts": [ { "rail": "Telebirr", "account_masked": "••••3344" } ]
}
```
Give the driver's phone one of the three links: `deep_link` (opens the 2Pay app), `android_intent` (opens the app if installed, otherwise the web page), or `terminal_url`
(the app also claims this https address on Android; elsewhere it opens in the browser).

**Retrying is safe.** The same `partner_ride_id` is the same ride. While unpaid it can be re-sent (a fresh link replaces the old one; the fare or accounts may change). Once
paid it answers `409 ALREADY_PAID`; with a payment in progress `409 PAYMENT_IN_PROGRESS`; for a different driver `409 DRIVER_MISMATCH`.

**Check a ride:** `GET .../session/{session_id}` or `GET .../session?partner_ride_id=...` returns `status` (`OPEN`, `PAID`, `CANCELLED`, `EXPIRED`) and, once paid, the payment with
`base_fee`, `vat_fee`, `total_fee`, `net_driver_settlement` and the rail used. **Cancel:** `DELETE .../session/{session_id}` (not once paid or in progress).

*Not built:* a push notification (webhook) from 2Pay to the partner when a ride is paid. Partners poll the status call for now.

### What happens on the phones
- **Driver's phone** (`/terminal?session_token=...`, or `twopay://checkout?token=...` in the app): no sign-in; the long random link is the credential (kept only as a hash, expires with the ride, 30 minutes by default).
  It asks the server for a pay node (`/pay/<token>`, 90 seconds, single use), presents it by **tap** (the 2Pay Android app acts as an NFC tag) and **QR**, keeps a fresh one ready, and waits for the result with a
  **held request** (answered about one network hop after the payment clears), then chimes and shows the paid screen. Fare and accounts come from the ride, never from the phone.
- **Passenger's phone** (`/pay/<token>`): the usual hub: tap **your own** bank or wallet app and the best of the driver's accounts is chosen (same institution or bank family first, then the same kind), or tap
  **one of the driver's accounts directly** (listed masked under the app grid). Then the passenger's app opens, pre-filled, when the operator has configured its link (`RAIL_APP_LINKS`; see `docs/VAULT_NODE_HUB.md`).

### Security notes
- The driver's account numbers are stored **encrypted** (when `DATA_ENCRYPTION_KEY` is set), on the ride and on its sale, and are never returned to any browser, terminal or partner call (only masked).
- The partner API is rate limited; the link calls are rate limited per network and per link; every ride creation, change and cancellation is audited with masked accounts and never the key or link.
- **Risk to know about:** the payout accounts are supplied by the partner for each ride, so a partner whose API key is stolen could redirect payouts. Mitigations in place: hashed keys, instant switch-off and rotation, audit. A later hardening step is registering each driver's accounts with 2Pay once and checking rides against them.
- Rides are recorded in the ledger of the merchant the partner is attached to (the live-payment checks for that merchant, including Fayda, apply).

---

## 2. Fayda e-KYC by FAN and one-time code

Two routes now verify an owner (the older browser sign-in route from V2.4 remains for when the National ID Program enables it):
1. `POST /api/kyc/fayda/initiate { fan }` asks the gateway to text a code to the phone linked to that 16-digit FAN, and returns `fayda_session_id`.
2. `POST /api/kyc/fayda/verify-otp { fayda_session_id, otp }` checks it; on success the owner is marked verified.

Stored: `fayda_verified`, `fayda_verification_timestamp`, `fayda_transaction_id`, the FAN **encrypted** (`fayda_fan`), the attested name encrypted, and a keyed fingerprint of the FAN. The national ID number is not kept.
While a code is pending the FAN waits in `fayda_sessions` (encrypted) and is erased when the request is finished. Controls: owner only, 5 requests per hour per business, 10 per 10 minutes per network, 5 wrong codes spend the request,
10-minute expiry, audit entries (`kyc.fayda.initiate`, `kyc.fayda.verified`) with only the last four digits.

**Mandatory with real money.** In `RAIL_MODE=live`, starting a sale is refused (`FAYDA_REQUIRED`) until the owner is verified, unless `KYC_REQUIRE_FAYDA=false`.
The business profile shows the step ("National ID (Fayda)": FAN, then the code).

**Sandbox:** `FAYDA_SANDBOX_MODE=true` accepts any 16-digit FAN with the code `123456`. It is **ignored in live mode**.

**What 2Pay cannot do alone.** The real gateway is granted by the National ID Program to an onboarded organisation, and its endpoints and message format are theirs. `src/lib/fayda-ekyc.ts` assumes
`POST {FAYDA_EKYC_URL}/otp` and `/verify` with a bearer key and a small JSON body; it is tested against a stand-in, not the real service. Adapting it to their specification is a change in that one file. Also confirm with counsel
what may be retained under the Personal Data Protection Proclamation.

---

## 3. Bank and wallet logos

`getRailLogo(railCode)` (`src/lib/rail-logos.ts`) returns a local logo, or a CDN logo you configure, or nothing, in which case the hub draws a coloured initials badge. The customer hub now shows branded cards (each institution keeps its own colour)
for the app grid, for the merchant's rails and for a driver's accounts.

**Logos are not included.** Official marks belong to each bank and wallet and come with their brand kit or written permission; redrawing or hotlinking unknown CDNs would be wrong. Put the files in `public/assets/rails/` and register them in
`LOGO_FILES` (instructions in `public/assets/rails/README.md`).

---

## 4. Tiered fees with 15% VAT

`src/lib/pricing/engine.ts` (`priceTransaction`), replacing the old formula:

| Amount (ETB) | Fee before VAT | + 15% VAT | Total deducted |
|---|---|---|---|
| under 100 | 0.50 | 0.075 | **0.575** |
| 100 to under 500 | 0.86 rising to 0.989: `0.86 + ((T - 100) / 400) * 0.129` | 15% of that | base x 1.15 |
| 500 to under 5,000 | 1.50 | 0.225 | **1.725** |
| 5,000 to under 10,000 | 2.00 | 0.300 | **2.300** |
| 10,000 and over | 5.00 (hard cap) | 0.750 | **5.750** |

VAT is charged on 2Pay's fee only. Figures are held in ten-thousandths of an ETB (integer arithmetic, so no rounding drift); `net_merchant_settlement = amount - total fee`.
The schedule jumps at 100 ETB (0.50 to 0.86) and at 500 ETB (about 0.989 to 1.50) because those are the published brackets. A payment too small to cover its own fee (about 0.58 ETB) is refused (`AMOUNT_TOO_SMALL`).

**Where it is recorded.** `createPayNode` (used by `POST /api/transactions`, the shop QR and ride sales; this repository has no `/api/tokens/mint`, the cashier terminal's "mint" is `POST /api/transactions`) stores on every sale
`base_fee`, `vat_fee`, `net_merchant_settlement`, and `fee_ft` (the total, so existing reports keep working). Sales made before V2.5 keep these three empty. The admin hub's old fee simulator is replaced by the schedule and a calculator,
so nothing on screen contradicts what is charged.

Tests: `__tests__/pricing.test.ts` (the ten boundary amounts 99.99, 100, 300, 499.99, 500, 4,999, 5,000, 9,999, 10,000 and 50,000, plus ledger arithmetic), `tests/fayda-ekyc.test.ts` (ledger columns on real sale creation), `tests/e2e/e2e.mjs`.
