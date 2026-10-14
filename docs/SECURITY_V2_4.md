# V2.4: security vault, managers, encryption, national ID (Fayda), routing and sound

2Pay is still **non-custodial**: it never holds money. This release hardens who may change where money goes, protects stored data, and connects owner KYC to the national ID.
Each section says what is built, what is tested, and what depends on someone else.

---

## 1. Adding, changing and removing bank / wallet accounts

**The rule.** Anything that can send money somewhere new needs **two locks at once**:

1. the approver's **6-digit security key** (something they know), and
2. a **one-time code texted to the approver's own phone** (something they hold).

**Who can approve.** The **owner**, and any **manager** the owner has added (Team tab > role *Manager*). Cashiers and waiters can never start or approve a change; this is enforced on
the server, so it holds whatever the app shows. A manager approves with their **own** key and their **own** phone, so the audit trail names the person, and removing a manager removes their power at once.

**What needs the two locks** (`classifyChange` in `src/lib/settlement-security.ts`): removing an account, editing an account's number or bank, switching which account receives money,
and adding an account that becomes active. The first account of a new business, or an extra account that is not activated, does not (nothing exists yet to divert).

**Flow.**
1. The server answers `403 VAULT_SETUP_REQUIRED` (no key or no phone yet) and the app runs **enrolment**: choose a key, confirm the phone with a code (`.../vault/enroll/request` and `/verify`).
   The key is stored only as a **scrypt hash** with a per-person salt. Nobody at 2Pay can read it.
2. For a change, the server answers `403 STEP_UP_REQUIRED`. The app asks for the key and sends a code to the approver's phone (`.../step-up/request`, which takes **no phone number** from the caller).
3. `.../step-up/verify` checks key and code together. A signed pass cookie `2pay_stepup` is set: bound to this business, this approver and this phone, **5 minutes**, `HttpOnly`, `SameSite=Strict`.
4. The change goes through, the owner is **texted** about it, and the change is recorded in the append-only `settlement_change_log` (account numbers cut to the last four).

**Brute force.** Five wrong keys lock the approver for **15 minutes** and text the owner. Codes are hashed, single use, five attempts, rate limited per IP and per phone.

**Test mode.** While `AUTH_ENFORCED` is off, the gate still applies (the approver is the owner), so you can see the real behaviour before launch. There is no admin bypass.

**Forgotten or locked key (2Pay support).** There is deliberately no self-service reset. In the admin hub, the **Security keys** tab lists every owner and manager (key set / locked / not chosen yet). After you have called the registered number and confirmed who is asking, press **Reset or unlock**, write how you confirmed it (required, kept in the audit log), and choose:
- **Reset security key:** removes the key. The person must then choose a new one, which needs a code sent to their registered phone, so a reset alone never lets anyone change an account. Unused account-change codes for that phone are cancelled, and both the person and the owner are texted ("reset by 2Pay support").
- **Unlock only:** clears a 15-minute lock and keeps the key.

Only admins (`ADMIN_PHONES`) can use it; it is rate limited (20 per hour); the list never shows a key or hash. Audit actions: `vault.key_reset`, `vault.unlock`.

**Honest limit.** The code goes to the approver's phone. If a thief holds both the unlocked phone and knows the key, they pass. A biometric prompt in the Android app (`BiometricPrompt`) is the natural third factor.

---

## 2. Encryption

| Layer | What protects it |
|---|---|
| In transit | HTTPS only (HSTS, 2 years, includeSubDomains). Cookies `Secure`, `HttpOnly`, `SameSite`. |
| Browser has no database | The browser holds no database credential; all reads and writes go through the server (`lockdown_reads.sql`, RLS deny-all). |
| At rest, field level | **AES-256-GCM** (`src/lib/fieldcrypt.ts`) on bank/wallet account numbers, TINs and the Fayda name. A separate key per purpose is derived from `DATA_ENCRYPTION_KEY` with HKDF, so a value copied from one column will not decrypt as another. Every value carries a key id and is authenticated, so tampering is detected. |
| Database provider | Supabase encrypts disks at rest as well; field encryption protects against database dumps, leaked backups and anyone with read access to the tables. |
| Secrets | Security keys: scrypt. One-time codes: HMAC, never stored in clear. Sessions and passes: HMAC-signed. National ID subject: keyed hash. |

**Setting it up.** Generate a key (`openssl rand -base64 32`), put it in Vercel as `DATA_ENCRYPTION_KEY`, and **back it up**. Without the key, encrypted fields cannot be read.
`/api/health` shows `security.fieldEncryption: true` when it is active.

**Rotation.** Put the old key in `DATA_ENCRYPTION_KEY_PREV`, set a new `DATA_ENCRYPTION_KEY`; rows are re-sealed under the new key whenever they are saved.

**Existing rows.** Rows written before the key was set stay readable (plaintext passthrough) and become encrypted the next time they are saved. The app also **refuses to write** if it finds rows it cannot decrypt, so a wrong key can never silently destroy data.

**Not built.** Hardware key management (KMS/HSM) and per-merchant keys. `DATA_ENCRYPTION_KEY` lives in Vercel's encrypted environment; moving it to a KMS is a natural next step for the licence stage.

---

## 3. National ID (Fayda) KYC

**What is built** (`src/lib/fayda.ts`, `/api/merchants/:id/fayda/start`, `/api/fayda/callback`): the OpenID Connect flow used by eSignet-style providers:
authorisation code with **PKCE**, a signed `state` cookie and a `nonce`, client authentication with **private_key_jwt (RS256)**, the ID token and signed userinfo verified against the provider's published keys (issuer, audience, nonce, expiry).
It is tested end to end against a **pretend provider** (`tests/e2e/fake-fayda.mjs`), including a reused code and a wrong verifier being refused.

**What is kept.** Only the minimum: when it was verified, a **keyed hash** of the person's unique ID (so the same person cannot be attached to many businesses unnoticed) and their name, encrypted. No photo, no address, no ID number.

**Gate.** With `KYC_REQUIRE_FAYDA=true`, live payments are refused until the owner has verified. It is off until Fayda is connected.

**What 2Pay cannot do alone.** Fayda access is granted by the **National ID Program** to an onboarded organisation: you receive the issuer URL, a client id, and you register the public half of your key.
The endpoints, claim names and scopes here follow the common standard but were **not tested against the real service**; expect small adjustments (`FAYDA_SCOPES`, `FAYDA_ACR_VALUES`, claim names) during onboarding.
Also confirm with counsel what you may retain under the Personal Data Protection Proclamation.

---

## 4. The customer's tap: pre-filled payment in any app, across banks

After the tap the customer chooses their own app (the phone cannot tell us which are installed). The server then:

1. picks the right merchant account (`chooseRoute`: same bank or family first, same kind next, else the only one);
2. decides the **transfer kind** (`transferFor`): **internal** (same bank), **interbank** (EthSwitch "transfer to other banks"), or **wallet**;
3. builds the link for that customer app and transfer kind from `RAIL_APP_LINKS`, filling `{account}`, `{amount}`, `{bank}`, `{bank_code}` (from `ETS_BANK_CODES`), `{name}`, `{ref}`, `{url}`, `{payload}`;
4. if the page stays visible after about 1.6 s it falls through to web checkout, so a missing link never blocks a sale.

So **when the banks differ**, the customer's app is sent to its interbank-transfer screen with the merchant's bank code, account number and the exact amount already filled in.

**Nothing app-specific is invented.** Every bank and wallet owns its link format, Android package and iOS scheme, and EthSwitch owns the bank codes and the ETHQR template.
Until you enter them (no code change needed), customers are sent to web checkout. Ask each partner for: link format, package/scheme, and whether the transfer screen accepts pre-filled fields.

---

## 5. Chime and voice

The chime plays the moment a payment clears on the merchant side, and the Amharic/English voice 1.5 s later when the digital receipt is issued, on **both** the merchant and the customer screens.
- Android: the chime is a pre-built audio track and the recorded Amharic clip is a prepared player, so playback starts without decoder delay (`NativeBridge.kt`). **Needs the new APK (2.4.0).**
- Web: if the browser blocks audio before any touch, the sound is queued and plays on the first touch (`announceWhenAllowed`). The customer's pay page "primes" audio at the first tap on the page.
- Payment detection is a held request (about 200 ms), so the sound is not waiting for a poll.

---

## 6. Guardrail review (what was checked)

| Area | State |
|---|---|
| Cross-site request guard | **New.** Every state-changing API request from another website's origin (or `Sec-Fetch-Site: cross-site`) is refused in middleware; provider webhooks and the nightly job (server to server) are exempt and use signatures/secrets. Tested. |
| Content-Security-Policy | **Now enforced** (was report-only): same-origin scripts, connections, fonts, workers, media; https images only; no framing; fixed `base-uri`/`form-action`. Still allows inline scripts that Next.js injects. |
| Sessions | Signed, `HttpOnly`, `SameSite`; owner/manager/cashier/waiter roles enforced on the server for every route. |
| Tenant isolation | Every data route checks the session's business; tested cross-tenant. |
| Rate limits, SSRF limits, webhook signatures, audit log | In place and tested (see `tests/`). |
| Dependencies | Audited; the remaining PostCSS advisories are build-time only and need a Next.js major upgrade. |
| **Still open** | Sign-in with PIN and phone OTP is **off** (`AUTH_ENFORCED`) and SMS is not configured. **Turn both on before any real merchant uses the system**: until then anyone with a link can see merchant data. Also: an independent penetration test, nonce-based CSP, a KMS for the data key, a biometric factor, and the forgotten-key support procedure. |
