# Waiter app lock, settlement vault and customer routing hub (V2.3)

Three upgrades, all non-custodial: 2Pay still never holds money. Each section says what is built and what depends on someone else.

---

## 1. The waiter node is the Android app

**Why the app.** A web page cannot emulate an NFC card, so only a native app can broadcast the tap. Waiters therefore work in the 2Pay Android app
(`com.twopay.merchant`), which already presents the sale's pay link over Host Card Emulation. Cashiers and owners may still use a browser.

### Activation link (`twopay://activate/<token>`)

- The owner adds a waiter (`POST /api/merchants/:id/staff`). The server makes a 256-bit random token, stores **only its SHA-256 hash** and a 72-hour expiry,
  and returns both forms of the link **once**:
  - `https://<site>/join/<token>` (works everywhere; opens inside the app when installed, see below), and
  - `twopay://activate/<token>` (the app's own scheme).
  The link is also texted (English and Amharic) when an SMS gateway is configured.
- **Opening it:**
  - `AndroidManifest.xml` registers `twopay://activate` and the verified `https://<site>/join` path. `public/.well-known/assetlinks.json` publishes the app's
    signing fingerprint, so Android opens the https link directly in the app with no chooser.
  - `MainActivity.openFromIntent` turns `twopay://activate/<token>` into the activation page on our own host. The token must be **exactly** 43 URL-safe
    characters, so nothing else can be smuggled through the scheme.
  - If the link is opened in a normal browser, `/join/<token>` shows "Open in the 2Pay app" (an Android `intent://` link with a fallback to `/download`) and
    "Get the 2Pay app", and does **not** offer to activate. (Open to browsers only when `AUTH_ENFORCED` is off, for testing, or `ALLOW_BROWSER_NODES=true`.)

### Binding the device to the master tenant

1. `POST /api/auth/otp/request { invite_token }` sends a one-time code **to the number the owner entered**, never to a number the caller supplies. A waiter
   request from a browser is refused (`APP_REQUIRED`) **before** an SMS is spent.
2. `POST /api/auth/otp/verify { challenge_id, code, invite_token, device_id }`. `device_id` comes from the app itself (`TwoPayNative.deviceId()`): a random id
   created once per installation and kept in the app's private storage (gone on uninstall). The server stores `sha256(device_id)` on the `merchant_staff` row,
   marks it activated, **clears the link** (single use) and issues the session `{ mid (the master's tenant), rl: "WAITER", sid (the waiter) }`.
3. From then on that waiter can sign in only from that installation. A different phone is refused ("linked to another phone") even with a correct code, until
   the owner presses **New link**, which releases the old phone.

The user-agent check (`TwoPayMerchantApp/<version>`) is a guard against honest mistakes, **not** a security boundary: a user agent can be faked. What protects the
account is the code to the invited number, the single-use link and the one-phone binding.

### The programmatic lock (a read-only terminal)

A waiter session can do exactly two things: start sales (stamped with their id) and read their own sales and tips. This is enforced **on the server**, so it holds
whatever the app shows:

- every settings, money-routing, staff, profile, refund, ads and export route requires the OWNER role and refuses a waiter (`403`);
- `/api/transactions` and `/api/team/ledger` return only rows with `staff_id = sid` for a waiter;
- the receiving accounts are never sent to the phone: a sale carries a **masked** snapshot of the master's accounts, and the real numbers stay on the server.

On the phone itself, **node mode** (`TwoPayNative.setNodeMode(true)`, switched on for every non-owner session) restricts the WebView to the terminal, sign-in
and activation pages and never hands a link to another app. The NFC broadcast is the existing one: it carries the current sale's pay link, so the tag is
"pre-filled" with the master's accounts through the server, not with account data on the phone.

---

## 2. The settlement vault

### What is protected

`merchants.saved_banks`, `saved_wallets`, `active_bank`, `active_wallet`.

**Database layer** (`supabase/v2_3.sql`, defence in depth):
- RLS is on and the public roles have no privilege on these columns (`lockdown_reads.sql` revokes everything from `anon` / `authenticated`). Only the server's
  service role touches them, after it has checked the session, the tenant and the role.
- **A tamper-evident history.** A trigger (`log_settlement_change`) writes every change to `settlement_change_log` whoever makes it, with account numbers cut to
  their last four digits. The table is append-only: `UPDATE` and `DELETE` raise an error, so the record of what changed and when cannot be rewritten.

**Application layer** (`src/lib/settlement-security.ts`, `PUT /api/merchants/:id/settlement`): `classifyChange(before, after)` decides what needs the owner's code:

| Change | Code needed? |
|---|---|
| Very first account (nothing exists yet to divert) | no |
| Adding an extra account that is not activated | no (it cannot receive money until activated) |
| Removing an account | **yes** |
| Editing an account's number or bank | **yes** |
| Switching which account receives money (including adding a second kind that becomes active) | **yes** |

### The step-up gate

1. The server answers `403 { code: "STEP_UP_REQUIRED" }` and the app shows **"Confirm it's you"**.
2. `POST /api/merchants/:id/settlement/step-up/request` (owner only) sends a one-time code **only to the phone registered on the business**. The request carries no
   phone number, so there is nothing to point it elsewhere. Rate limited per IP and per phone. The SMS names what the code is for.
3. `POST .../step-up/verify { challenge_id, code }` checks it (hashed, five attempts, single use, must be a step-up code for this business's phone) and sets a signed
   pass cookie (`2pay_stepup`: this business, this phone, **5 minutes**, `HttpOnly`, `SameSite=Strict`, scoped to `/api/merchants`).
4. The change is retried automatically and accepted. A tampered pass, another business's pass, or an expired one is refused.
5. After any sensitive change the owner is **texted** ("the account where your business receives money was just changed"), and the audit log records the change,
   the step-up and any blocked attempt.

Staff cannot start any of this: both routes are owner-only. Sign-in enforcement turns the gate on (`AUTH_ENFORCED=true`); in test mode it is open like everything else.

**Not built:** a biometric challenge. The Android app could add `BiometricPrompt` as a second factor in front of the code; that is a natural next step. Also note the code
goes to the *owner's* phone, so protection against a rogue **owner session** relies on that phone being separate from the device a thief holds.

---

## 3. The customer routing hub

**The constraint.** iOS and Android do not let a web page or an NFC payload see which banking apps are installed. So 2Pay does not guess: the **customer taps
their own app on a grid**, and the server picks which of the merchant's active accounts should receive it.

### The grid (`/pay/<token>`)

Wallets (Telebirr, CBE Birr, M-Pesa ...) and banks (CBE, Awash, Dashen, Bank of Abyssinia ...) as tiles; "More banks and wallets" shows the whole national list; "My app
is not listed" falls back to the merchant's two methods. The customer's last app is remembered on their own phone. `POST /api/pay/:token/initiate { payer_app }`
accepts only a known national bank or wallet (anything else is refused, never stored).

### Choosing the merchant's account (`src/lib/routing-hub.ts`, `chooseRoute`)

1. **Same institution** (or the same bank family: CBE Birr to a CBE account, AwashBirr to an Awash account): an internal transfer, so use it.
2. **Same kind:** a wallet customer pays the merchant's wallet; a bank customer pays the merchant's bank.
3. **Only one account configured:** that one.

The choice and the customer's app are stored on the sale (`transactions.payer_app`, `settlement_method`, `rail`).

### Dynamic ETHQR and the app deep link

`buildEthQr()` (`src/lib/ethqr.ts`, on the EMVCo encoder `emvqr.ts`) assembles, for one payment, an EMVCo merchant-presented QR with the chosen account, the exact amount
(including any tip), the merchant name, category code and our reference, with a correct CRC. `resolveAppLink()` (`src/lib/applinks.ts`) then builds the link that opens
the customer's app:

```jsonc
// RAIL_APP_LINKS, keyed by the CUSTOMER's app. Placeholders: {url} {payload} {amount} {ref}
{
  "CBE Birr": {
    "android": "intent://pay?data={payload}#Intent;scheme=<their scheme>;package=<their package>;S.browser_fallback_url={url};end",
    "ios":     "<their scheme>://pay?data={payload}",
    "any":     "https://<their web link>?pay={url}"
  }
}
```

The pay page tries the app link, and if the page stays visible after about 1.6 s it continues to the web checkout, so a wrong or missing link never blocks a payment.
Dangerous schemes (`javascript:`, `data:` ...) are never emitted, and `intent:` links are used only on Android.

### What is deliberately NOT built in, and why

- **No app's link format is hard-coded.** A link such as `cbebirr://pay?data=...` is a guess unless that institution has published it, and a guess would send customers
  to a dead end. Each bank or wallet gives its scheme, Android package and expected payload; you enter them in `RAIL_APP_LINKS`. **No code change is needed.**
- **No ETHQR template is built in.** The national scheme's merchant-account template (tag, GUID, sub-fields) is defined by EthSwitch / the National Bank. Supply it as
  `ETHQR_TEMPLATE={"tag":26,"guid":"<guid>","fields":{"01":"{account}"}}`. Until then no payload is built, and templates that need `{payload}` are skipped.
- **A bank-app payment must come back as a settlement notice.** When the customer pays from their app straight to the merchant's account, the money moves between banks;
  2Pay marks the sale paid only when a provider callback says so. That feed, per institution, is the integration to ask each partner for.
- **The payload contains the merchant's receiving account number** (that is what a payment QR is). It is built only when a configured template needs it, held in
  memory for the request, and never stored or logged. The token that reaches it is single-use and lives 90 seconds.

---

## Configuration added

| Variable | Purpose |
|---|---|
| `RAIL_APP_LINKS` | per-app links, string or `{android, ios, any}` objects (see above) |
| `ETHQR_TEMPLATE` | the national scheme's merchant-account template (from EthSwitch) |
| `ALLOW_BROWSER_NODES` | `true` lets waiters use a browser (testing only) |

Database: run `supabase/v2_3.sql` **before** deploying V2.3 (part of `all_migrations.sql`).
