# Data residency and the AI layer (V2.6)

**The requirement.** Once 2Pay is operating, transaction data must stay in Ethiopia. The screens (UI/UX) stay on Vercel with no transaction data. An AI intelligence layer on Google Cloud runs in parallel to every transaction.

This document is the strategy, what V2.6 already builds, and the runbook for the move. Nothing in V2.6 moves any data yet: it makes the move a configuration change instead of a rewrite.

---

## 1. The three zones

```
 Browser / Android app
      |  screens                      |  every /api call, directly (cookies, CORS)
      v                               v
 [ VERCEL: screens only ]       [ IN-COUNTRY CORE (Ethiopia) ]  <---- payment provider and bank callbacks
   DEPLOY_ROLE=ui                 DEPLOY_ROLE=core
   no database credentials        the API + the Postgres database + the encryption key
   answers no /api request        every sale, account, key, KYC record, audit entry
                                          |
                                          |  signed, pseudonymised events (outbox)   scores back (signed)
                                          v
                                  [ GOOGLE CLOUD: AI layer ]
                                    never holds payment credentials, never moves money
```

**Why the browser talks to the core directly.** If the screens host proxied the API, every transaction would still pass through Vercel, outside the country. So the pages call `https://api.<domain>` themselves. As a bonus, Ethiopian users get a faster API (in-country) than they would reaching a distant region.

**What this needs from you:** one **custom domain** with two names, for example `app.2pay.et` (screens) and `api.2pay.et` (core). A `*.vercel.app` address cannot share a sign-in cookie with a server elsewhere, so the split cannot work without your own domain.

## 2. What V2.6 builds now

| Piece | What it does |
|---|---|
| `DEPLOY_ROLE` (`all` / `ui` / `core`) | One codebase, three modes. `ui` has **no database access at all** (the database client refuses even if credentials were put there by mistake), answers no `/api/*` request (except `/api/health`), and holds no sale, account or person's record. `all` (default) is today's single deployment. |
| `NEXT_PUBLIC_API_BASE` | The address of the API for browsers. Empty = same host (today). When set, every browser request to `/api/...` goes there, with cookies, installed in one place (`src/lib/api-base.ts`). |
| `UI_ORIGINS`, CORS | The API accepts browser calls only from the screens host(s) you list, with cookies. Everything else stays blocked, and the cross-site request guard still protects every change. |
| `COOKIE_DOMAIN` | Sets the sign-in cookie on the shared parent domain (`.2pay.et`) so both the screens and the API see it. |
| `API_BASE_URL` | Where payment providers send callbacks (the core), separate from the screens address. |
| `SUPABASE_URL` | The server-side name for the database address (the old `NEXT_PUBLIC_SUPABASE_URL` still works), so the in-country database address is never published to browsers. |
| Server-side admin totals | The admin hub's totals, node list, evidence and Fayda counts are computed **in the database** (v2_6.sql functions), pages and searches are small, and exports stream: nothing in the admin hub grows with the number of merchants or sales. |
| The AI event outbox | See section 4. |
| Health | `/api/health` shows `role` and whether AI events are on; the screens-only deployment answers without a database. |

I audited the code: **no page or component reads the database**; only API route handlers do. So the screens deployment can be data-free without changes to any screen.

## 3. The move, step by step (a runbook, not yet executed)

1. **Decide and obtain:** the in-country host (a data centre or cloud inside Ethiopia), the two domain names, and an in-country place for the encryption key.
2. **Stand up the core** from this repository: Node 20+ running `next start` (or a container) with `DEPLOY_ROLE=core`, a private network to the database, TLS in front, and the same environment variables as today (see below).
3. **Stand up the database in-country:** Postgres 15+ with PostgREST (Supabase self-hosted is the closest match, because the code talks to the database through the Supabase client). Apply `supabase/all_migrations.sql`, then `supabase/lockdown_reads.sql`.
4. **Rehearse on a copy:** `pg_dump` the current Supabase database (logical, `--no-owner`), restore it into the in-country database, point a *staging* core at it, and run the whole end-to-end suite (`tests/e2e`) and a real sandbox payment against it.
5. **Cut over in a short window:** put the app in maintenance (or stop the terminals), take a final dump, restore it, switch `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` on the core, set the screens deployment to `DEPLOY_ROLE=ui` with `NEXT_PUBLIC_API_BASE=https://api.<domain>`, move the provider callbacks (`API_BASE_URL`) to the core, run `npm run encrypt-existing` only if keys changed, and check `/api/health` on both.
6. **Keep the old database read-only for a rollback period**, then securely delete it (and tell Supabase to delete backups). Rollback = point the core back at the old database (data written since the cutover would have to be carried back).
7. **Move the secrets:** `DATA_ENCRYPTION_KEY` and `SESSION_SECRET` live on the core only; the screens deployment needs neither (it needs `SESSION_SECRET` only if you keep page-level sign-in gating there).
8. **Android:** the app loads the screens host and the screens call the API host; both must be under the shared domain for the sign-in cookie. Rebuild the app with the new start address when the domains exist.

### Environment matrix

| Variable | UI (Vercel) | Core (Ethiopia) |
|---|---|---|
| `DEPLOY_ROLE` | `ui` | `core` |
| `NEXT_PUBLIC_API_BASE` | `https://api.<domain>` | (not needed) |
| `PUBLIC_BASE_URL` | `https://app.<domain>` | `https://app.<domain>` (links and redirects point at the screens) |
| `API_BASE_URL` | | `https://api.<domain>` (provider callbacks) |
| `UI_ORIGINS` | | `https://app.<domain>` |
| `COOKIE_DOMAIN` | | `.<domain>` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **none** | the in-country database |
| `DATA_ENCRYPTION_KEY`, `SESSION_SECRET`, provider and SMS secrets, `AI_*` | none (except `SESSION_SECRET` if pages are gated) | all of them |

## 4. The AI layer, in parallel and never in the way

**Design rules:** it must never slow a payment, never lose an event, never learn who anyone is, and never be able to move money.

1. **Outbox.** Every sale writes small events (`CREATED`, `STARTED`, `SETTLED`, `FAILED`) to `ai_event_outbox` in the in-country database. The write is one insert done *after* the response has gone, so the payment never waits for it.
2. **Dispatcher.** Right after the insert, and again from a safety-net job (`/api/cron/ai-events`, protected by `CRON_SECRET`; run it every minute from the core's own scheduler), the outbox is sent in batches to `AI_EVENT_SINK_URL`, **signed** (`x-2pay-timestamp`, `x-2pay-signature = sha256 HMAC of "<timestamp>.<body>"`), with retries that wait longer each time. If Google Cloud is slow or down, sales are unaffected and events simply wait.
3. **Pseudonymised before it is written.** The merchant and the sale are keyed hashes (`AI_PSEUDONYM_KEY`, which only 2Pay holds); the amount is a band (`<100`, `100-499`, ...); plus Addis Ababa hour and weekday, channel (terminal / ride / shop QR), institution, provider, payer app, whether a tip was left, and settle latency. **Never** an account number, phone, name, pay link, terminal id or exact amount. `AI_EVENT_LEVEL=full` adds the exact amount, tip and fee, only if counsel agrees.
4. **Scores come back** signed to `POST /api/ai/score` (`{ scores: [{ tx_ref, score 0-100, model, reasons[] }] }`), checked for signature and freshness (five minutes, so a captured call cannot be replayed), and stored in `ai_scores` beside the sale. A score is information for the Watchdog and the admin hub; it changes nothing about a payment by itself.
5. **Off by default.** It runs only when `AI_EVENT_LEVEL` is `features` or `full` and the sink address and both secrets are set.

### Event shape
```json
{ "v": 1, "event_id": "uuid", "stage": "SETTLED", "occurred_at": "2026-10-15T09:30:00.000Z",
  "tx": "3f9c...32 hex", "merchant": "a81e...32 hex",
  "features": { "amount_band": "500-4999", "hour_eat": 12, "weekday_eat": 4, "channel": "TERMINAL", "ride": false,
                "institution": "Telebirr", "provider": "arifpay", "method": "WALLET", "payer_app": "CBE Birr", "tip": true, "latency_ms": 1400 } }
```
A batch is `{ "events": [ ... ] }`. The AI layer authenticates 2Pay with the shared `AI_EVENT_SECRET` and answers `2xx` to acknowledge.

## 5. Open questions that are not engineering

1. **Is sending derived, pseudonymised event data to Google Cloud allowed?** Google Cloud has **no Ethiopian region** (the nearest is in South Africa), so any AI processing on it is processing outside the country. Whether pseudonymised, banded features count as "transaction data" under the National Bank's rules and the Personal Data Protection Proclamation (including its cross-border transfer rules) is a question for counsel and the Bank. The default is "off", and `features` is the least that can be sent. An alternative if the answer is no: run the AI models in-country, or send only on-device or aggregate signals.
2. **In-country hosting and its resilience:** uptime, backups held in-country, disaster recovery, and who operates it.
3. **Domain:** the two names, and who controls the DNS.
4. **A key store in-country** for `DATA_ENCRYPTION_KEY` (an HSM or a managed KMS inside the country), instead of an environment variable.
5. **Regulator sign-off** on the architecture before cutover, and on retaining Fayda-derived data.

## 6. What is deliberately not done yet
- No data has been moved, and no second deployment exists. V2.6 only makes the split a configuration change.
- No real Google Cloud endpoint is connected (the tests use a stand-in that checks the signature).
- No automatic in-country failover.
