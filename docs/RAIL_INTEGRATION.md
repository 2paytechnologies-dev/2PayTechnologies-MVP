# Integrating a payment rail

2Pay is an orchestration layer: it creates a single-use pay node, lets the payer choose the merchant's bank or wallet,
hands the payment to a **rail** (a provider such as Arifpay, a bank API, or a wallet API), and marks the sale paid only when
the rail confirms. Each rail is one **adapter**; nothing else in the app knows which provider is in use.

## How a live payment flows

```
Terminal  --POST /api/transactions-->  pay node (PENDING), merchant's active bank/wallet snapshotted
Payer     --scans QR / taps phone-->   /pay/<token>   (GET /api/pay/<token>)
Payer     --taps "Pay via Awash Bank"-> POST /api/pay/<token>/initiate     {method, phone}
          adapter.createPayment(...)  -> provider session; sale becomes PROCESSING; payer is redirected to the provider
Provider  --callback-->                POST /api/webhooks/<provider>        (verified, stored, then applied)
          sale becomes SETTLED (or FAILED); amount checked against what was quoted
Terminal  polls /api/transactions/status -> "Payment Received"
Payer     lands on /pay/<token>/receipt (waits for confirmation if the callback is a moment behind)
```

Where the code lives:

| Piece | File |
|---|---|
| Adapter contract (`RailAdapter`) | `src/lib/rails/types.ts` |
| Registry, `RAIL_MODE`, public URL | `src/lib/rails/index.ts` |
| Arifpay adapter | `src/lib/rails/arifpay.ts` |
| Start a payment | `src/app/api/pay/[token]/initiate/route.ts` |
| Receive callbacks (any provider) | `src/app/api/webhooks/[provider]/route.ts` |
| Stuck-payment alerts | `src/app/api/cron/reconcile/route.ts` |
| Schema | `supabase/rails_live.sql` |

## Safety properties (tested)

- In **live mode** the simulated `authorize` route returns 403, and after `supabase/lockdown_reads.sql` the database function
  behind it is not callable with the public key. The only path to "paid" is a verified provider callback.
- A callback is **stored first** (`rail_events`, valid or not), **authenticated second**, and **applied last**.
- Settlement is single-shot: replays and concurrent retries cannot settle twice. A callback for an unknown nonce changes nothing.
- A payer who returns to a started payment gets the **same** provider session, never a second charge.
- If the amount the rail collected differs from the amount quoted, the sale still settles (money moved) and a **CRITICAL**
  watchdog alert is raised.
- A payment stuck in `PROCESSING` is never failed automatically (money may have moved); the daily job raises an alert instead.
- Success, cancel and notify URLs come from `PUBLIC_BASE_URL`, never from the request's Host header.

## Going live with Arifpay

What was verified against Arifpay's **public sandbox** (`https://gateway.arifpay.org`):
`POST /api/sandbox/c2b/session` with header `x-arifpay-key` returns `{ data: { sessionId, paymentUrl } }`, and 2Pay creates
real sandbox sessions with it.

What is **not** in Arifpay's public documentation and must be confirmed with Arifpay before real money moves:

1. **The production session path.** Set `ARIFPAY_SESSION_PATH` to it. (Left at the sandbox path by default so nothing can go live by accident.)
2. **The callback payload and how it is signed.** The parser is deliberately tolerant (it finds `transactionStatus`, `nonce`,
   `transactionId`, amount and method wherever they are nested), and callbacks are authenticated by a token embedded in the
   notify URL we register (`?k=...`, derived from `ARIFPAY_WEBHOOK_SECRET`) and, if Arifpay sends one, an HMAC in
   `x-arifpay-signature`. **Run a sandbox payment end to end, then read `rail_events`** (the raw payloads are all there) and
   correct `parseWebhook` if the real shape differs.
3. **Bank codes** for splitting funds straight into a merchant's bank account (`ARIFPAY_USE_BENEFICIARIES=true` with
   `ARIFPAY_BANK_CODES`). 2Pay refuses to guess a bank code. Without beneficiaries, collected funds go to *your* Arifpay merchant
   account, which is a custody and licensing question to settle with counsel and the National Bank before launch.
4. **Wallet payouts.** Collecting from a wallet is supported through the hosted checkout; paying a merchant's wallet needs
   Arifpay's disbursement (B2C) API, which is not wired yet.

Steps:

1. Get production credentials and the three answers above from Arifpay.
2. In Vercel set `RAIL_PROVIDER=arifpay`, `PUBLIC_BASE_URL`, `ARIFPAY_API_KEY`, `ARIFPAY_SESSION_PATH`, `ARIFPAY_DEFAULT_EMAIL`,
   `ARIFPAY_WEBHOOK_SECRET`. Keep `RAIL_MODE=simulated` while testing.
3. Run `supabase/rails_live.sql`. Test in the sandbox with a tiny amount; inspect `rail_events`.
4. Run the go-live checklist in `docs/GO_LIVE.md`, then set `RAIL_MODE=live`.

## Adding another rail (bank API, wallet API, another aggregator)

1. Create `src/lib/rails/<provider>.ts` exporting a `RailAdapter`:
   - `createPayment(req)` starts the payment and returns `{ sessionId, checkoutUrl }`. `checkoutUrl` can be a provider-hosted page or an
     app deep link. Put `req.nonce` into the provider request so it comes back in the callback.
   - `notifyUrl(baseUrl)` returns the callback URL to register (with any authenticity token).
   - `verifyWebhook({ rawBody, headers, url })` returns `"ok" | "bad" | "unconfigured"`, and must **fail closed** (`"unconfigured"`)
     in production when no secret is set.
   - `parseWebhook(body)` returns `{ status: "SETTLED" | "FAILED" | "PENDING", nonce, amount, providerRef, paymentMethod }` or `null`.
2. Register it in `ADAPTERS` in `src/lib/rails/index.ts`.
3. Point the provider's callback at `https://<your-domain>/api/webhooks/<provider-id>`.
4. Set `RAIL_PROVIDER=<provider-id>` (one active provider per deployment today; per-institution routing is a natural next step:
   choose the adapter from `req.institution` in `initiate`).

Nothing else changes: the terminal, tap-to-pay, checkout, receipt, ads, reconciliation and dashboards are provider-agnostic.
