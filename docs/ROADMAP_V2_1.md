# V2.1: what is built, and what needs someone else

The ten gaps between 2Pay and Tap-style, Apple-Pay-style payments, and where each one stands.

| # | Item | State |
|---|---|---|
| 1 | Remember the payer / one-tap return | **Built.** Payer phone and language are kept (server-only), pre-filled next time, and the receipt page offers "pay again". |
| 2 | Open the bank / wallet app | **Built.** `RAIL_APP_LINKS` deep links with web checkout as fallback. Needs each institution's real link format. |
| 3 | Payer app / iOS App Clip | **Not built.** An App Clip needs an Apple Developer account ($99/yr), a Mac with Xcode, and an associated domain. The pay page is already built to be that experience. |
| 4 | Interoperable (EMVCo) QR | **Groundwork.** Encoder with CRC and tests. Needs the national scheme's merchant template (EthSwitch) before it can be accepted by other banks' apps. |
| 5 | Amharic | **Built** across merchant and payer screens (English default, Amharic on Ethiopian phones, menu on every screen). Oromo and Tigrinya are not started. Needs native-speaker review. |
| 6 | USSD / SMS pay, static QR / NFC stickers | **Static QR built** (shop page `/t/<terminal>`, printable bilingual poster). **USSD not built:** needs a shortcode from Ethio Telecom / Safaricom. |
| 7 | Merchant tools | **Built.** Refund requests, staff (owner / cashier) accounts, end-of-day report (print / PDF), SMS receipts. Push notifications need Firebase. |
| 8 | Smart routing | **Built and tested.** One real adapter today, so nothing to route between until a second provider is added. |
| 9 | Platform | **Built:** health endpoint, error telemetry, DB rate limiting, enforced + report-only CSP, security headers, CI, 46 unit + 103 end-to-end checks, dependency audit. **Needs outsiders:** penetration test, uptime-monitor account, load test against the live provider. |
| 10 | Privacy / terms / KYC | **Built:** Terms and Privacy pages (EN / AM), consent at sign-up, payer phones kept in a private table, TIN and account numbers masked, audit log, retention job (off until configured), business-details review with a live-payment gate. **Needs a lawyer** to review the legal text and the National Bank rules. |

## Other things added in V2.1

- Brand-blue (`#0B2545`) app icon, favicon and Apple touch icon instead of white.
- "Get paid" screen: pick a bank or wallet from a list with logos-by-colour, type the account, done. Replaces the old settlement-routing
  screen. Up to 3 of each, one is "in use", and the account number is masked after saving.
- Android 2.1.0: printing from inside the app, in-app update banner driven by `/downloads/latest.json`.

## Next steps in order of payoff

1. Run `supabase/v2_1.sql`, deploy, run the sandbox end-to-end test (`docs/GO_LIVE.md`).
2. Native Amharic read-through of the app and legal pages.
3. Get the provider's production session path, callback format and signing from Arifpay.
4. Ask a second provider for an adapter so routing has something to do.
5. Apple Developer account for the App Clip; Firebase project for push; telecom shortcode for USSD.
6. Commission the penetration test before public launch.
