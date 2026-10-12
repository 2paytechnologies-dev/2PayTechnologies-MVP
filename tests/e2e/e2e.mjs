// End-to-end test of the V2.1 server flows through the REAL routes, against tests/e2e/mock-postgrest.mjs and (for one
// call) Arifpay's public SANDBOX. See tests/e2e/README.md for how to run it.
import http from "node:http";
import { createHmac } from "node:crypto";
import { signSession } from "../../src/lib/session.ts";

const BASE = process.env.BASE ?? "http://localhost:3170";
const MOCK = process.env.MOCK ?? "http://localhost:4020";
const SESSION_SECRET = "q".repeat(48);
const WEBHOOK_SECRET = "unit-test-webhook-secret-0123456789";
const A = "1f5f43ec-bbef-40da-87fe-797cd61d1e86";
const B = "2a2a2a2a-0000-4000-8000-000000000002";
const CRON = "cron-secret-for-tests";
const now = Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
const failures = [];
const t = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); if (ok) pass++; else { fail++; failures.push(`${name}${detail ? "  -> " + detail : ""}`); } };
const section = (s) => console.log(`\n== ${s}`);

const cookie = async (mid, ph, rl) => `2pay_session=${await signSession({ mid, ph, rl, exp: now + 3600 }, SESSION_SECRET)}`;
const ownerA = await cookie(A, "+251911000001", "OWNER");
const cashierA = await cookie(A, "+251911000099", "CASHIER");
const ownerB = await cookie(B, "+251911000002", "OWNER");
const admin = await cookie(B, "+251711000111", "OWNER");

async function call(method, path, { ck, body, headers = {}, raw = false } = {}) {
  const r = await fetch(BASE + path, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  let data = null;
  try { data = raw ? await r.text() : await r.json(); } catch { /* not json */ }
  return { status: r.status, data, headers: r.headers };
}
const db = async () => (await fetch(MOCK + "/__db")).json();
const notifyToken = createHmac("sha256", WEBHOOK_SECRET).update("2pay:arifpay:notify:v1").digest("hex").slice(0, 40);

// --- SMS capture: the app is configured to "send" SMS to this local server
const sms = [];
http.createServer((req, res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { sms.push(JSON.parse(s)); res.writeHead(200); res.end("{}"); }); }).listen(4030);
const smsTo = (phone) => sms.filter((m) => m.to === phone);

async function liveSale(merchantCookie, amount, { lang = "en", phone = "0911223344", source = "terminal", terminal = "TRM-0002" } = {}) {
  let token;
  if (source === "static") {
    const r = await call("POST", `/api/public/terminal/${terminal}/pay`, { body: { amount } });
    token = r.data?.token;
  } else {
    const r = await call("POST", "/api/transactions", { ck: merchantCookie, body: { merchant_id: A, amount } });
    token = r.data?.token;
  }
  if (!token) return { token: null };
  // The real Arifpay sandbox is a shared public service and sometimes answers slowly or with a 5xx; try a few times.
  let init;
  for (let attempt = 1; attempt <= 4; attempt++) {
    init = await call("POST", `/api/pay/${token}/initiate`, { body: { method: "wallet", phone, lang } });
    if (init.status < 500) break;
    console.log(`  (sandbox answered ${init.status}: ${init.data?.error ?? ""}; retrying ${attempt}/3)`);
    await wait(2000 * attempt);
  }
  const row = (await db()).transactions.find((x) => x.token === token);
  return { token, init, nonce: row?.rail_nonce, id: row?.id };
}
const settle = (nonce, amount, ref = "TXN-" + nonce.slice(0, 6)) => call("POST", `/api/webhooks/arifpay?k=${notifyToken}`, { body: { nonce, transactionStatus: "SUCCESS", transaction: { transactionId: ref, amount, transactionStatus: "SUCCESS" }, paymentType: "TELEBIRR" } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================================================================
section("health, headers and public pages");
{
  const h = await call("GET", "/api/health");
  t("health reports ok + version and exposes no secret VALUES", h.status === 200 && h.data.ok && h.data.version && ![SESSION_SECRET, WEBHOOK_SECRET, CRON, "service"].some((v) => JSON.stringify(h.data).includes(v)) && Object.values(h.data.auth).every((v) => typeof v === "boolean"), JSON.stringify(h.data).slice(0, 120));
  const p = await call("GET", "/signin", { raw: true });
  t("CSP enforced: framing and plugins are blocked", /frame-ancestors 'none'/.test(p.headers.get("content-security-policy") ?? "") && /object-src 'none'/.test(p.headers.get("content-security-policy") ?? ""));
  t("strict CSP is being collected in report-only mode", !!p.headers.get("content-security-policy-report-only"));
  for (const path of ["/t/TRM-0002", "/poster/TRM-0002", "/terms", "/privacy", "/download", "/signin", "/"]) t(`public page ${path}`, (await call("GET", path, { raw: true })).status === 200);
  t("a protected page redirects an anonymous visitor", [307, 308].includes((await call("GET", "/dashboard/merchant", { raw: true })).status));
}

section("business verification gates live payments (KYC)");
{
  const blocked = await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: 40 } });
  t("an unverified business cannot create a live sale", blocked.status === 403 && blocked.data.code === "KYC_REQUIRED", blocked.data?.error);
  const g0 = await call("GET", `/api/merchants/${A}/profile`, { ck: ownerA });
  t("profile loads; the TIN is not exposed", g0.status === 200 && !("tin" in g0.data) && g0.data.has_tin === false);
  t("a cashier cannot read the profile", (await call("GET", `/api/merchants/${A}/profile`, { ck: cashierA })).status === 403);
  t("another merchant cannot read it", (await call("GET", `/api/merchants/${A}/profile`, { ck: ownerB })).status === 403);
  const detail = { legal_name: "NOC Ethiopia PLC", business_license: "AA/12/3456", address: "Megenagna, Addis Ababa", location: "Megenagna" };
  t("a malformed TIN is rejected", (await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { ...detail, tin: "12345" } })).status === 400);
  const sub = await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { ...detail, tin: "0012-345-678" } });
  t("valid details are submitted for review (status SUBMITTED, TIN masked)", sub.status === 200 && sub.data.kyc_status === "SUBMITTED" && sub.data.tin_masked === "••••••5678" && !("tin" in sub.data), sub.data?.kyc_status);
  const resubmit = await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { ...detail, tin: "" } });
  t("a blank TIN keeps the one on file", resubmit.status === 200 && resubmit.data.has_tin === true);
  const q = await call("GET", "/api/admin/kyc?status=SUBMITTED", { ck: admin });
  t("an admin sees the submission with the full TIN", q.status === 200 && q.data.some((m) => m.id === A && m.tin === "0012345678"));
  t("a merchant cannot use the admin review queue", (await call("GET", "/api/admin/kyc", { ck: ownerA })).status === 403);
  t("rejecting needs a reason", (await call("PATCH", `/api/admin/kyc/${A}`, { ck: admin, body: { status: "REJECTED" } })).status === 400);
  t("an admin verifies the business", (await call("PATCH", `/api/admin/kyc/${A}`, { ck: admin, body: { status: "VERIFIED" } })).status === 200);
  t("it cannot be reviewed twice", (await call("PATCH", `/api/admin/kyc/${A}`, { ck: admin, body: { status: "REJECTED", note: "x" } })).status === 409);
  const ok = await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: 40 } });
  t("once verified, the sale can be created", ok.status === 201);
}

section("roles: owner vs cashier");
{
  const sale = await call("POST", "/api/transactions", { ck: cashierA, body: { merchant_id: A, amount: 15 } });
  t("a cashier can run the terminal", sale.status === 201);
  t("a cashier can see the live status of a sale", (await call("GET", `/api/transactions/status?tokens=${sale.data.token}`, { ck: cashierA })).status === 200);
  // an old paid sale (3 days ago) exists for merchant A
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  await fetch(MOCK + "/rest/v1/transactions", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ merchant_id: A, amount: 77, expected_amount: 77, fee_ft: 0.4, status: "SETTLED", created_at: old, expires_at: old, rail: "Telebirr" }) });
  const q = `merchant_id=${A}&from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`;
  const own = await call("GET", `/api/transactions?${q}`, { ck: ownerA });
  const cash = await call("GET", `/api/transactions?${q}`, { ck: cashierA });
  t("the owner sees full history", own.status === 200 && own.data.rows.some((r) => Number(r.amount) === 77));
  t("a cashier is limited to the last 24 hours", cash.status === 200 && !cash.data.rows.some((r) => Number(r.amount) === 77) && cash.data.rows.length > 0);
  for (const [name, method, path, body] of [
    ["money routing (read)", "GET", `/api/merchants/${A}/settlement`],
    ["money routing (change)", "PUT", `/api/merchants/${A}/settlement`, { banks: [], wallets: [], active_bank_id: null, active_wallet_id: null }],
    ["ad campaigns", "GET", `/api/ads/campaigns?merchant_id=${A}`],
    ["staff list", "GET", `/api/merchants/${A}/staff`],
    ["refund requests", "GET", `/api/refunds?merchant_id=${A}`],
    ["watchdog alerts", "GET", `/api/watchdog?merchant_id=${A}&type=SETTLEMENT_MISMATCH&since=2026-01-01T00:00:00Z`],
  ]) t(`a cashier cannot use ${name}`, (await call(method, path, { ck: cashierA, body })).status === 403);
  const ml = await call("GET", "/api/merchants", { ck: cashierA });
  t("a cashier sees only their own business", ml.data.length === 1 && ml.data[0].id === A);
}

section("staff accounts");
{
  const phoneCashier = "0911 000 099";
  t("an invalid phone is rejected", (await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Almaz", phone: "123" } })).status === 400);
  t("a cashier cannot add staff", (await call("POST", `/api/merchants/${A}/staff`, { ck: cashierA, body: { name: "X Y", phone: "0911000555" } })).status === 403);
  t("a number that already owns an account is refused", (await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Rival", phone: "0911000002" } })).status === 409);
  const add = await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Almaz", phone: phoneCashier } });
  t("the owner adds a cashier (phone is masked in the reply)", add.status === 201 && !JSON.stringify(add.data).includes("0911000099") && add.data.phone_masked?.includes("•••"));
  t("the same number cannot be added twice", (await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Again", phone: phoneCashier } })).status === 409);
  const list = await call("GET", `/api/merchants/${A}/staff`, { ck: ownerA });
  t("the team list never contains full phone numbers", list.status === 200 && list.data.length === 1 && !JSON.stringify(list.data).includes("911000099"));

  // the cashier signs in through the real OTP flow and receives a CASHIER session
  const req = await call("POST", "/api/auth/otp/request", { body: { phone: phoneCashier, purpose: "login" } });
  await wait(300);
  const code = smsTo("+251911000099").at(-1)?.message.match(/(\d{6})/)?.[1];
  t("a cashier's number can request a sign-in code (SMS sent)", req.status === 200 && !!code && !("dev_code" in req.data), `status ${req.status}`);
  const ver = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: req.data.challenge_id, code } });
  const set = ver.headers.get("set-cookie") ?? "";
  const payload = JSON.parse(Buffer.from(set.split("2pay_session=")[1].split(".")[0], "base64url").toString());
  t("the session cookie carries role CASHIER for the owner's business", ver.status === 200 && payload.rl === "CASHIER" && payload.mid === A && ver.data.role === "CASHIER");

  const rm = await call("DELETE", `/api/merchants/${A}/staff/${add.data.id}`, { ck: ownerA });
  t("removing a cashier works", rm.status === 200);
  t("removing twice finds nothing", (await call("DELETE", `/api/merchants/${A}/staff/${add.data.id}`, { ck: ownerA })).status === 404);
  const req2 = await call("POST", "/api/auth/otp/request", { body: { phone: phoneCashier, purpose: "login" } });
  t("a removed cashier's number can no longer sign in", req2.status === 404, `status ${req2.status}`);
}

section("registration needs the terms");
{
  const req = await call("POST", "/api/auth/otp/request", { body: { phone: "0911555000", purpose: "register" } });
  await wait(300);
  const code = smsTo("+251911555000").at(-1)?.message.match(/(\d{6})/)?.[1];
  const base = { challenge_id: req.data.challenge_id, code, business_name: "Tomoca Bole", category: "Retail" };
  const noTerms = await call("POST", "/api/auth/otp/verify", { body: base });
  t("registering without accepting the terms is refused (code is not spent)", noTerms.status === 400 && /Terms/.test(noTerms.data.error));
  const ok = await call("POST", "/api/auth/otp/verify", { body: { ...base, accepted_terms: true } });
  const m = (await db()).merchants.find((x) => x.phone === "+251911555000");
  t("accepting the terms creates the account and records when", ok.status === 200 && ok.data.created && ok.data.role === "OWNER" && !!m?.terms_accepted_at);
}

section("scan-to-pay shop QR");
{
  await fetch(MOCK + "/__reset");
  const info = await call("GET", "/api/public/terminal/TRM-0002");
  t("public shop info (no sign-in) says it is accepting", info.status === 200 && info.data.accepting === true && info.data.business_name === "NOC Station Megenagna");
  t("no bank numbers or phones in the public info", !JSON.stringify(info.data).match(/1000123456789|911223344|account_number|"phone"|"tin"/));
  t("an unknown shop is a 404", (await call("GET", "/api/public/terminal/TRM-9999")).status === 404);
  t("a malformed shop id is a 404", (await call("GET", "/api/public/terminal/nope")).status === 404);
  t("an amount below the minimum is refused", (await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 0.5 } })).status === 400);
  t("an amount above the cap is refused", (await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 30000 } })).status === 400);
  t("a shop with no payment account cannot take scan-to-pay", (await call("POST", "/api/public/terminal/TRM-0003/pay", { body: { amount: 20 } })).data?.code === "NO_ACTIVE_ROUTING");
  await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { static_qr_enabled: false } });
  const off = await call("GET", "/api/public/terminal/TRM-0002");
  const offPay = await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 20 } });
  t("the merchant can switch scan-to-pay off", off.data.accepting === false && offPay.status === 403 && offPay.data.code === "STATIC_QR_DISABLED");
  await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { static_qr_enabled: true } });
  const good = await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 25 } });
  const row = (await db()).transactions.find((x) => x.token === good.data.token);
  t("a valid amount creates a pay node tagged STATIC_QR with the shop's routing", good.status === 201 && row?.source === "STATIC_QR" && row.routed_bank?.institution === "Awash Bank");
  await fetch(MOCK + "/__reset");
  let limited = 0;
  for (let i = 0; i < 14; i++) if ((await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 10 } })).status === 429) limited++;
  t("rapid-fire creation is rate limited (10 per minute per payer)", limited >= 3, `${limited} of 14 refused`);
  await fetch(MOCK + "/__reset");
}

section("payer receipts by SMS (live rail sandbox + callbacks)");
{
  sms.length = 0;
  const s1 = await liveSale(ownerA, 25, { source: "static", lang: "en" });
  t("a scanned-shop sale starts a REAL Arifpay sandbox session", s1.init?.status === 200 && s1.init.data.url?.startsWith("https://checkout.arifpay.org/"), s1.init?.data?.url ?? s1.init?.data?.error);
  const contact = (await db()).payer_contacts.find((c) => c.transaction_id === s1.id);
  t("the payer's phone is kept in the separate contact table, not on the sale", contact?.phone === "+251911223344" && !("payer_phone" in (await db()).transactions.find((x) => x.id === s1.id)));
  t("no receipt is sent before payment is confirmed", smsTo("+251911223344").length === 0);
  t("the rail's confirmation settles the sale", (await settle(s1.nonce, 25)).status === 200);
  await wait(300);
  const r1 = smsTo("+251911223344");
  t("exactly one English receipt SMS is sent", r1.length === 1 && /25\.00 ETB paid to NOC Station Megenagna/.test(r1[0].message) && r1[0].message.includes("2P-"), r1[0]?.message);
  await settle(s1.nonce, 25);
  await wait(200);
  t("a replayed confirmation sends no second SMS", smsTo("+251911223344").length === 1);

  const s2 = await liveSale(ownerA, 60, { lang: "am", phone: "0922334455" });
  await settle(s2.nonce, 60);
  await wait(300);
  const r2 = smsTo("+251922334455");
  t("a payer who used the Amharic screens gets an Amharic receipt", r2.length === 1 && r2[0].message.includes("60.00 ብር"), r2[0]?.message);

  await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { sms_receipts: false } });
  const s3 = await liveSale(ownerA, 35, { phone: "0933445566" });
  await settle(s3.nonce, 35);
  await wait(300);
  t("with SMS receipts switched off, none is sent", smsTo("+251933445566").length === 0);
  await call("PUT", `/api/merchants/${A}/profile`, { ck: ownerA, body: { sms_receipts: true } });
  const rc = await call("GET", `/api/pay/${s1.token}/receipt`);
  t("the receipt page data is available after settlement", rc.status === 200 && rc.data.status === "SETTLED");
}

section("refund requests");
{
  const txs = (await db()).transactions.filter((x) => x.status === "SETTLED" && x.merchant_id === A && Number(x.amount) === 25);
  const settled = txs[0];
  const pending = await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: 12 } });
  const pendingId = (await db()).transactions.find((x) => x.token === pending.data.token).id;
  const body = (o = {}) => ({ merchant_id: A, transaction_id: settled.id, amount: 10, reason: "Customer returned the item", ...o });
  t("a cashier cannot request a refund", (await call("POST", "/api/refunds", { ck: cashierA, body: body() })).status === 403);
  t("a reason is required", (await call("POST", "/api/refunds", { ck: ownerA, body: body({ reason: "x" }) })).status === 400);
  t("an unpaid sale cannot be refunded", (await call("POST", "/api/refunds", { ck: ownerA, body: body({ transaction_id: pendingId }) })).status === 400);
  t("more than the sale amount is refused", (await call("POST", "/api/refunds", { ck: ownerA, body: body({ amount: 999 }) })).status === 400);
  t("another business cannot refund this sale", (await call("POST", "/api/refunds", { ck: ownerB, body: { ...body(), merchant_id: B } })).status === 404);
  const rq = await call("POST", "/api/refunds", { ck: ownerA, body: body() });
  t("the owner requests a partial refund", rq.status === 201 && rq.data.status === "REQUESTED");
  t("only one open request per sale", (await call("POST", "/api/refunds", { ck: ownerA, body: body() })).status === 409);
  const mine = await call("GET", `/api/refunds?merchant_id=${A}`, { ck: ownerA });
  t("the owner sees it with its sale reference", mine.data.length === 1 && mine.data[0].reference.startsWith("2P-"));
  const all = await call("GET", "/api/admin/refunds", { ck: admin });
  t("an admin sees it with the business name", all.status === 200 && all.data[0].business_name === "NOC Station Megenagna");
  t("a merchant cannot use the admin queue", (await call("GET", "/api/admin/refunds", { ck: ownerA })).status === 403);
  const id = rq.data.id;
  t("rejecting needs a reason", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "REJECTED" } })).status === 400);
  t("it cannot jump straight to REFUNDED", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "REFUNDED" } })).status === 409);
  t("approve", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "APPROVED" } })).status === 200);
  t("approving twice is refused", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "APPROVED" } })).status === 409);
  t("mark refunded", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "REFUNDED", admin_note: "Returned via Arifpay" } })).status === 200);
  t("a finished refund is final", (await call("PATCH", `/api/admin/refunds/${id}`, { ck: admin, body: { status: "REJECTED", admin_note: "no" } })).status === 409);
  const after = await call("GET", `/api/refunds?merchant_id=${A}`, { ck: ownerA });
  t("the merchant sees the outcome and the note", after.data[0].status === "REFUNDED" && after.data[0].admin_note === "Returned via Arifpay");
}

section("audit log, telemetry, scheduled jobs");
{
  await call("PUT", `/api/merchants/${A}/settlement`, { ck: ownerA, body: { banks: [{ id: "b0b0b0b0-0000-4000-8000-000000000001" }], wallets: [{ id: "c0c0c0c0-0000-4000-8000-000000000002" }], active_bank_id: "b0b0b0b0-0000-4000-8000-000000000001", active_wallet_id: "c0c0c0c0-0000-4000-8000-000000000002" } });
  const log = await call("GET", "/api/admin/audit?limit=300", { ck: admin });
  const actions = new Set(log.data.map((e) => e.action));
  for (const a of ["kyc.submit", "kyc.verified", "staff.add", "staff.remove", "refund.request", "refund.approved", "refund.refunded", "settlement.update", "auth.login", "account.register"]) t(`audit has ${a}`, actions.has(a));
  t("a merchant cannot read the audit log", (await call("GET", "/api/admin/audit", { ck: ownerA })).status === 403);
  t("audit entries never contain full TINs or account numbers", !JSON.stringify(log.data).match(/0012345678|1000123456789/));

  t("an error report is accepted from anyone", (await call("POST", "/api/telemetry/error", { body: { message: "TypeError: boom", stack: "at x", url: "/terminal", source: "android" } })).status === 202);
  t("an empty report is refused", (await call("POST", "/api/telemetry/error", { body: {} })).status === 400);
  const errs = await call("GET", "/api/admin/errors", { ck: admin });
  t("an admin sees reported errors", errs.status === 200 && errs.data.some((e) => e.message === "TypeError: boom" && e.source === "android"));
  t("a merchant cannot read error reports", (await call("GET", "/api/admin/errors", { ck: ownerA })).status === 403);

  t("the nightly jobs refuse callers without the secret", (await call("GET", "/api/cron/retention")).status === 401 && (await call("GET", "/api/cron/reconcile")).status === 401);
  const ret = await call("GET", "/api/cron/retention", { headers: { authorization: `Bearer ${CRON}` } });
  t("retention runs; deleting old sales is OFF unless explicitly configured", ret.status === 200 && ret.data.transactionPurge === "disabled", JSON.stringify(ret.data));
  const rec = await call("GET", "/api/cron/reconcile", { headers: { authorization: `Bearer ${CRON}` } });
  t("reconciliation runs", rec.status === 200 && "checked" in rec.data);
}

if (failures.length) console.log("\nFAILED:\n" + failures.map((f) => "  - " + f).join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
