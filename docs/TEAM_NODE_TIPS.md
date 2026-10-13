# Team nodes and tips (V2.2)

A business registers one bank account and one wallet. Any number of waiters and cashiers then take payments on **their own
phones**, and every payment still settles **straight to the business account**. Nobody's personal account is ever involved,
so there is nothing to hand over at the end of a shift. 2Pay stays non-custodial and holds no float: it only records who took
each sale and how much of each payment was a tip.

> Names: a "team member" is a row of `merchant_staff` (created in V2.1, extended in V2.2). `waiter_id` = `transactions.staff_id`,
> `receipt_amount` = `transactions.amount` (the locked bill), `calculated_tip` = `transactions.tip_amount`, `settled_amount` is unchanged.

---

## 1. Database (`supabase/v2_2.sql`)

Run it **before** deploying V2.2 (it is idempotent and also part of `supabase/all_migrations.sql`).

```sql
-- team members: number, activation link (hash only), phone binding
alter table merchant_staff add column if not exists team_no           text;
alter table merchant_staff add column if not exists invite_token_hash text;
alter table merchant_staff add column if not exists invite_expires_at timestamptz;
alter table merchant_staff add column if not exists activated_at      timestamptz;
alter table merchant_staff add column if not exists device_id_hash    text;
alter table merchant_staff add column if not exists device_label      text;
alter table merchant_staff add column if not exists last_seen_at      timestamptz;
alter table merchant_staff add constraint merchant_staff_role_check check (role in ('CASHIER', 'WAITER'));
create unique index merchant_staff_team_no_uq on merchant_staff (merchant_id, team_no) where team_no is not null;
create unique index merchant_staff_invite_uq  on merchant_staff (invite_token_hash)    where invite_token_hash is not null;

-- sales: who took it, and the tip
alter table transactions add column if not exists staff_id   uuid references merchant_staff(id);
alter table transactions add column if not exists tip_amount numeric(12,2) not null default 0 check (tip_amount >= 0);
create index transactions_staff_idx on transactions (merchant_id, staff_id, created_at desc) where staff_id is not null;
```

**Row-level security.** Both tables have RLS enabled and **no policy and no grant for `anon` or `authenticated`**: with the public
key, every read and write is refused. This is deliberate. 2Pay's browsers hold no database credentials (see "Why not Supabase
Realtime" below); every request goes through a Next.js route that checks, in this order:

1. the signed session cookie (`mid` = the tenant, `rl` = OWNER / CASHIER / WAITER, `sid` = the team member);
2. that the session's `mid` equals the merchant being asked about (**tenant isolation**; an admin phone is the only exception);
3. the role: waiters see only rows with `staff_id = sid`; cashiers see every member's rows for the last 24 hours; only the owner
   manages the team, money routing, refunds, ads and exports;
4. for team members, that the member is still `active` (a removed waiter loses the ability to start sales at once).

Removed members are kept (`active = false`, link cleared) so past sales and ledgers still name them, and their team number is
never reused.

---

## 2. Provisioning and activation

**Adding a member** (`POST /api/merchants/:id/staff`, owner only): name, phone, role (`WAITER` or `CASHIER`).

- The server picks the next free team number for that role (`W-001`, `C-001`, ...), counting removed members, and retries on a race.
- It generates a 256-bit random token (`crypto.randomBytes(32)`, base64url), stores **only its SHA-256 hash** and an expiry
  (72 hours), and returns the link `https://<site>/join/<token>` **once**. The link is also texted (English and Amharic) when an
  SMS gateway is configured; otherwise the owner copies or shares it.
- A phone that already belongs to any 2Pay account is refused (one phone, one role). Up to 200 members per business.

**Activating** (`/join/<token>`, opens in the Android app or the browser):

1. `GET /api/team/invite?token=` shows only the business, the person's name and team number. An unknown, used or expired
   link all answer identically; the route is rate limited per IP and reveals no phone number.
2. `POST /api/auth/otp/request { invite_token }` sends a one-time code to **the number the owner entered** (never a number the
   caller supplies). A forwarded link alone therefore opens nothing.
3. `POST /api/auth/otp/verify { challenge_id, code, invite_token, device_id }`:
   - `device_id` is a random id kept on that phone (`localStorage`, see `src/lib/device.ts`). A missing id is refused **before**
     the code is spent.
   - on success the server stores `sha256(device_id)` and `activated_at`, **clears the link** (single use), and issues the
     session cookie `{ mid, ph, rl: "WAITER", sid }`.
4. Later sign-ins (`purpose: "login"`) must come from that same phone: another device is refused with
   "This account is linked to another phone", even with the right code. The owner's **New link** button issues a fresh link and
   releases the old phone (lost phone, new phone, expired link).

`sid` is only ever read from the signed cookie. A request that claims another waiter's id is ignored.

---

## 3. Tips: routing and calculation

The bill the waiter keys is **revenue** and is locked on the sale (`amount`, `expected_amount`). Anything the customer pays on top
is the **tip**. Two ways it happens, one rule:

**A. The customer chooses a tip on the pay page** (5 / 10 / 15 % or any amount; shown when a team member is serving the table).
`POST /api/pay/:token/initiate { method, phone, tip }`:

```ts
const tip = cleanTip(body.tip, bill);              // null when negative, not a number, or above the bill (max 50,000 ETB)
const charge = round2(bill + tip);                 // what the provider is asked to collect
// ... createPayment({ amount: charge, ... })
// at the moment the sale is claimed (PENDING -> PROCESSING):
update({ tip_amount: tip, expected_amount: charge })
```

**B. The customer simply pays more** (for example 800 against a 750 receipt, if the rail allows it). The webhook handles it:

```ts
// src/app/api/webhooks/[provider]/route.ts  (after the callback is authenticated and matched by nonce)
const quoted    = Number(tx.expected_amount ?? tx.amount);          // 750 (or bill + chosen tip)
const overpaid  = settled != null && settled - quoted > 0.005 ? round2(settled - quoted) : 0;   // 50
update({ status: "SETTLED", settled_amount: settled,
         ...(overpaid > 0 ? { tip_amount: round2(Number(tx.tip_amount ?? 0) + overpaid) } : {}) })
// overpaid  -> watchdog INFO   ("customer paid 800 against 750 quoted; the extra 50 was recorded as a tip")
// underpaid -> watchdog CRITICAL, no tip (a shortfall is never a negative tip)
```

Result for the 750 / 800 example: `amount = 750` (revenue), `tip_amount = 50`, `settled_amount = 800`. The settle update is single-shot
(`status in (PENDING, PROCESSING, SUCCESS)`), so a replayed callback cannot add the tip twice. All 800 ETB goes to the business account;
the tip is a ledger line, not a separate transfer, so 2Pay never moves or holds anyone's money. The pure rule is
`splitPayment()` in `src/lib/team.ts` (unit tested, including cents and shortfalls). The orchestration fee stays on the bill.

---

## 4. Real-time confirmation payload

When a sale settles, both screens need the same facts. They are defined once, in `ConfirmationEvent` (`src/lib/team.ts`) and built by
`toConfirmation()`:

```jsonc
{
  "type": "payment.confirmed",
  "id": "9f1c…",                       // transaction id
  "merchant_id": "1f5f…",
  "staff": { "id": "bb4f…", "name": "Abebe Kebede", "team_no": "W-001", "role": "WAITER" },   // null = owner/counter
  "currency": "ETB",
  "receipt_amount": 750.00,             // revenue (what the waiter keyed)
  "tip": 50.00,
  "total_paid": 800.00,
  "rail": "Telebirr",
  "settlement_method": "WALLET",
  "status": "SETTLED",
  "at": "2026-10-13T13:38:41Z"
}
```

- **The waiter's phone** polls `/api/transactions/status` for its own sale (every 0.6 s) and gets the chime, the spoken confirmation and
  the "750 sale + 50 tip" result screen the moment the sale settles.
- **The cashier's master terminal** polls `/api/transactions` (every 2 s). Each row carries `confirmation` (above), `staff_name` and
  `team_no`; the feed names the waiter, flags the tip and chimes. The owner and cashier also see `/api/team/ledger` (below).
- **Delivery today is polling**, answered by the server after the session and role checks. The payload is deliberately transport
  independent.

### Why not Supabase Realtime (yet)

Realtime delivers *table rows* to a browser that holds a Supabase JWT and relies on RLS policies keyed to that JWT. 2Pay's
production lockdown removes all browser access to the database (`supabase/lockdown_reads.sql`), because a Realtime-capable browser
credential is also a way to read the tables directly. Doing it safely means a **server-signed, per-tenant channel**, not row
subscriptions. When the pilot's poll volume justifies it, the upgrade path is:

```ts
// server, after settlement (webhook / simulated authorize), using the service role:
await admin.channel(`merchant:${merchantId}:payments`, { config: { private: true } })
           .send({ type: "broadcast", event: "payment.confirmed", payload: toConfirmation(row, staff) });
// browsers join with a short-lived token minted by /api/auth/realtime (claims: mid, rl, sid) and an RLS rule on
// realtime.messages that only allows topic `merchant:<mid>:payments`, or `merchant:<mid>:staff:<sid>` for waiters.
```

Waiters would subscribe to `merchant:<mid>:staff:<sid>` only, cashiers and owners to `merchant:<mid>:payments`. Nothing else changes: the payload is
already the one above.

---

## 5. The shift ledger

`GET /api/team/ledger?merchant_id&from&to` groups paid sales (`SUCCESS`, `SETTLED`) by team member:

```jsonc
{ "lines":  [ { "staff_id": "…", "name": "Abebe Kebede", "team_no": "W-001", "role": "WAITER", "sales": 3, "revenue": 300, "tips": 80, "total": 380 } ],
  "totals": { "sales": 3, "revenue": 300, "tips": 80, "total": 380 } }
```

The owner and the cashier see every line; a waiter's answer contains only their own line. Team members are limited to the last 24 hours.
The owner's Team tab and the cashier's terminal show it as "Today by team member"; the waiter's terminal shows "My shift today".

## 6. UI

- **Owner, Team tab** (`src/components/merchant/TeamTab.tsx`): add a waiter or cashier, copy or share the activation link, see each
  member's team number, state (waiting / active / expired), linked phone, **New link**, remove; plus the ledger.
- **Activation page** (`src/app/join/[token]/page.tsx`).
- **Waiter / cashier terminal** (`TerminalPanel`): "Signed in: Abebe · W-001", the result screen shows "750 sale + 50 tip", the feed names the
  waiter and marks tips (`+50 tip`), and the shift ledger sits underneath.
- **Customer** (`/pay/<token>`, receipt): "Served by Abebe · W-001", a tip chooser (No tip, 5 %, 10 %, 15 %, Other) with the total shown before
  paying, and a receipt that splits "750 + 50 Tip", names who served, and is included in the SMS receipt.

## 7. Limits and honest notes

- **Tips are recorded, not paid out by 2Pay.** The money is in the business account; paying the waiters their tips is the business's
  decision. The ledger is the record that makes that fair and auditable.
- **Tax.** Because every payment lands in the business account and carries the waiter's id, sales are provable. How tips are treated for
  tax is a question for the business's accountant and the revenue authority; the ledger separates revenue from tips so either answer works.
- **A shared phone.** A waiter's account is tied to their phone. If a phone is shared, use one phone per person; the owner can release a phone
  with **New link**.
- **iPhone.** The waiter app is the Android merchant app (or the browser). An iPhone browser works for the activation link and terminal
  without tap-to-pay; there is no iOS node app yet.
- **Amharic.** The Amharic strings were written by an AI and need a native review.
