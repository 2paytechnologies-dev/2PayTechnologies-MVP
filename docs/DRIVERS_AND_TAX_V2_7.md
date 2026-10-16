# V2.7: individual drivers, registration categories, the finished-trip catch, and the tax estimate

Run `supabase/v2_7.sql` **before** deploying (it is also in `all_migrations.sql`). 2Pay is still non-custodial.

---

## 1. Why drivers hold their own accounts

A ride-hailing company knows its drivers but not where they want to be paid. So from V2.7 the **driver registers with 2Pay themselves**
("Ride Service"), adds their own bank or wallet under *Get paid*, and **links** to each company they work for. When a trip ends the company
only says "driver X, fare 250"; 2Pay looks up X's linked 2Pay account and pays the account the driver set.

* A driver can be linked to **any number of companies at once**. Each company has its own id for the driver (`driver_id`); 2Pay maps it to the one driver account.
* One company id can be linked to **only one** 2Pay driver at a time (nobody can take over another driver's id).
* The company never sends, sees or stores the driver's bank or wallet details (it only sees masked account endings in the ride reply).
* **No TIN, business licence or Fayda check is asked of an individual driver.** A driver is `kind = DRIVER`; businesses are `MERCHANT`; ride companies `RIDE_PARTNER`.
  (The driver still has the phone code at sign-in and the security key + phone code for changing where money goes.)

## 2. Linking a driver to a company

All calls carry `Authorization: Bearer <company key>`. Base: `/api/v1/integrations/ride-hailing`.

| Call | What it does |
|---|---|
| `POST /drivers` `{ "driver_id": "zr-17", "phone": "0911223344" }` | Ask to link by phone. A registered driver gets a text and a request under **Rides** (status `PENDING`, `ACTIVE` once accepted). An unregistered number gets a text inviting them to install 2Pay (status `INVITED`; it becomes a request when they register with that number). A business number is refused (`NOT_A_DRIVER`). 3 texts per number per hour. |
| `POST /drivers/link-code` `{ "driver_id": "zr-17" }` | A one-time code like `ABCD-EFGH`, valid 30 minutes. The company shows it in its own app; the driver types it under **Rides > Link a company**. That links at once. A new code cancels earlier ones. Only a hash is stored. |
| `GET /drivers/{driver_id}` | `{ status: NONE / INVITED / PENDING / ACTIVE / REVOKED, ready }`. `ready` = linked **and** the driver has an account to be paid into. |
| `DELETE /drivers/{driver_id}` | The company unlinks the driver. Rides stop at once; the driver's account and other links are untouched. |

The driver can also unlink a company, or decline a request, in the app (Rides tab).

## 3. A finished trip (the automatic catch)

1. The trip closes in the company's app. The company's server calls `POST /session` with `{ partner_ride_id, driver_id, fare_amount, currency }` and **no account details**.
2. 2Pay checks the link is `ACTIVE` and the driver has an account (`DRIVER_NOT_LINKED` / `DRIVER_NO_ACCOUNTS` otherwise), prices the fare and records the ride against the driver's own ledger.
3. The driver's 2Pay app, which is **open and listening** (`GET /api/driver/rides/next`, a held request answered the moment a ride exists; measured about 100 ms after the company's call), shows the fare and opens the payment screen by itself.
4. The driver taps the passenger's phone (or shows the QR). The passenger's chosen payment app is opened with the right fare and the driver's accounts (masked), exactly as in the shop terminal.
5. When paid, the driver's screen turns green at once, and the company sees `PAID` with the fee breakdown.

**Honest limits.**
* The app must be open (the screen on) to catch a trip. There is **no push notification yet**: a closed or sleeping phone cannot be woken without Firebase Cloud Messaging, which needs a Firebase project and a new APK. The company can still launch the app itself with the `deep_link` / `android_intent` in the reply. Push is the recommended next step.
* If the ride is opened from a link instead (`twopay://checkout?token=...`), nothing about step 4 changes.

## 4. Companies that already send accounts (legacy mode)

Before V2.7 a company could send `driver_wallet_accounts` with each ride. That is now **refused by default** (`PARTNER_ACCOUNTS_NOT_ALLOWED`) because the company's copy of a driver's account is unverified. An admin can switch it back on per company (admin hub > Ride partners > *Allow legacy accounts*) while a company moves to linking. Do not keep the two demo companies enabled.

## 5. Registration categories

The business registration has a required **Category Selection**: Fuel Station, Supermarket, Service (restaurants, cafes, ...), Ride Service, Merchant (general). The old "Retail" value is kept for existing accounts and shows as "Merchant". Choosing **Ride Service** creates an individual driver; the others create businesses. The category sets the merchant category code on shop QRs (Fuel 5541, Supermarket 5411, Service 5812, Ride 4121, Merchant 5999), which ads target, and which turnover-tax rate applies.

## 6. Digital tax estimate

**What it is.** For a business registered with a **TIN and a business licence**, the Tax tab shows the estimated tax on what it took **through 2Pay**: by month, so far this year, and projected over the full year. It is an estimate for planning, not a return and not tax advice.

**How it is worked out** (`src/lib/tax.ts`):
* Turnover each month = settled sales minus refunds (Addis Ababa months). Tips and failed payments are not counted.
* The year is projected from the months that have passed. If the projection reaches the **VAT threshold**, VAT is estimated: the share inside a VAT-inclusive price (`turnover x rate / (1 + rate)`), or on top if the rules say prices exclude VAT. Below it, **turnover tax** at the business category's rate.
* Not included: cash and other channels, expenses, input-VAT credit, withholding, income tax.

**The rates are rules, not code.** Admin hub > **Tax rules** holds the VAT rate, the VAT threshold, whether prices include VAT, and the turnover-tax rate per category. Saving makes a **new version that is unconfirmed**; a named person confirms exactly that version once a tax adviser has checked it. Until a version is confirmed every merchant's Tax tab shows a warning that the rates are unchecked.

**Defaults, shipped unconfirmed.** VAT 15 % (prices inclusive), threshold 1,000,000 ETB a year, turnover tax 2 % for goods categories (fuel, supermarket, merchant) and 10 % for services and ride service. These are the long-standing figures. Ethiopian tax law has been changing (a new 2025 proclamation) and published sources disagree, so **do not treat them as current law**: have them confirmed before merchants rely on them.

API: `GET /api/merchants/{id}/tax?year=YYYY` (owner only; `eligible:false` plus what is missing when there is no TIN or licence). Admin: `GET/PUT/POST /api/admin/tax-rules`.

## 7. Tests

* Unit: `tests/v27.test.ts` (categories, link codes, tax rules and estimate maths, ride intents without accounts).
* End to end (`tests/e2e/e2e.mjs`): registration categories, the five choices, driver linking by phone and by code, several companies, auto-catch (held request), opening by ride id, unlinking, the legacy switch, the driver exemption, the network counts, and the tax estimate and rule versioning.
