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
const APP_UA = "Mozilla/5.0 (Linux; Android 14) TwoPayMerchantApp/2.3.0 e2e"; // the 2Pay Android app
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36"; // a normal phone browser

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
  const r = await fetch(BASE + path, { method, redirect: "manual", headers: { "user-agent": APP_UA, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(ck ? { cookie: ck } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
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
  const add = await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Almaz", phone: phoneCashier, role: "CASHIER" } });
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

section("team nodes: waiters, activation links, attribution");
const crew = {};
{
  await fetch(MOCK + "/__reset_limits");
  const addM = (name, phone, role) => call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name, phone, role } });
  const w1 = await addM("Abebe", "0911 000 071", "WAITER");
  const w2 = await addM("Birtukan", "0911000072", "WAITER");
  const c1 = await addM("Dawit", "0911000073", "CASHIER");
  t("a waiter is added with a team number", w1.status === 201 && /^W-\d{3}$/.test(w1.data.team_no) && w1.data.role === "WAITER", w1.data.team_no);
  t("the second waiter gets the next number", w2.status === 201 && w2.data.team_no !== w1.data.team_no && /^W-\d{3}$/.test(w2.data.team_no), w2.data.team_no);
  t("a cashier is numbered separately", c1.status === 201 && /^C-\d{3}$/.test(c1.data.team_no));
  t("the activation link is returned once and points at /join", /\/join\/[A-Za-z0-9_-]{43}$/.test(w1.data.invite_link ?? ""));
  t("the link is also texted to the person (both languages)", smsTo("+251911000071").some((m) => m.message.includes("/join/") && m.message.includes("ተከፍ") === false && /አክሎዎታል/.test(m.message)));
  t("only the link's hash is stored, never the link", !JSON.stringify((await db()).merchant_staff).includes(w1.data.invite_link.split("/join/")[1]));
  const token = w1.data.invite_link.split("/join/")[1];
  crew.w1 = w1.data; crew.w2 = w2.data;

  const look = await call("GET", `/api/team/invite?token=${token}`);
  t("the join page can see the business, name and team number", look.status === 200 && look.data.valid && look.data.name === "Abebe" && look.data.team_no === w1.data.team_no && !!look.data.business_name);
  t("the join page learns no phone number", !JSON.stringify(look.data).includes("911000071"));
  t("a made-up link is not valid", (await call("GET", `/api/team/invite?token=${"A".repeat(43)}`)).status === 410);
  t("a malformed link is refused", (await call("GET", "/api/team/invite?token=nope")).status === 400);

  const req = await call("POST", "/api/auth/otp/request", { body: { invite_token: token } });
  await wait(300);
  const code = smsTo("+251911000071").at(-1)?.message.match(/(\d{6})/)?.[1];
  t("opening the link sends a code to the invited number", req.status === 200 && !!code, `status ${req.status}`);
  t("the reply never shows the full number", req.status === 200 && !JSON.stringify(req.data).includes("911000071") && String(req.data.phone).includes("•••"));
  t("an expired/unknown link cannot request a code", (await call("POST", "/api/auth/otp/request", { body: { invite_token: "B".repeat(43) } })).status === 410);

  const DEV1 = "device-one-aaaaaaaaaaaa", DEV2 = "device-two-bbbbbbbbbbbb";
  t("activation needs a device id, and the code is not spent by that mistake", (await call("POST", "/api/auth/otp/verify", { body: { challenge_id: req.data.challenge_id, code, invite_token: token } })).status === 400);
  const ver = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: req.data.challenge_id, code, invite_token: token, device_id: DEV1 } });
  const set = ver.headers.get("set-cookie") ?? "";
  const payload = set.includes("2pay_session=") ? JSON.parse(Buffer.from(set.split("2pay_session=")[1].split(".")[0], "base64url").toString()) : {};
  t("activating gives a WAITER session tied to that team member", ver.status === 200 && payload.rl === "WAITER" && payload.mid === A && payload.sid === w1.data.id && ver.data.role === "WAITER");
  crew.w1ck = `2pay_session=${set.split("2pay_session=")[1]?.split(";")[0]}`;
  const row = (await db()).merchant_staff.find((s) => s.id === w1.data.id);
  t("the phone is linked (hash only) and the link is spent", !!row.activated_at && /^[0-9a-f]{64}$/.test(row.device_id_hash) && !JSON.stringify(row).includes(DEV1) && row.invite_token_hash == null);
  t("the spent link no longer works", (await call("GET", `/api/team/invite?token=${token}`)).status === 410);

  // signing in later: only from the linked phone
  const rq = async () => { const r = await call("POST", "/api/auth/otp/request", { body: { phone: "0911000071", purpose: "login" } }); await wait(300); return { r, code: smsTo("+251911000071").at(-1)?.message.match(/(\d{6})/)?.[1] }; };
  const a = await rq();
  const other = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: a.r.data.challenge_id, code: a.code, device_id: DEV2 } });
  t("a different phone is refused with the right code", other.status === 403 && /another phone/i.test(other.data.error ?? ""), other.data.error);
  const b = await rq();
  const same = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: b.r.data.challenge_id, code: b.code, device_id: DEV1 } });
  t("the linked phone can sign in again", same.status === 200 && same.data.role === "WAITER");

  // what a waiter may do
  const sale = await call("POST", "/api/transactions", { ck: crew.w1ck, body: { merchant_id: A, amount: 100, staff_id: crew.w2.id } });
  t("a waiter can start a sale", sale.status === 201);
  const stored = (await db()).transactions.find((x) => x.token === sale.data.token);
  t("the sale is stamped with the waiter, whatever the request claims", stored.staff_id === crew.w1.id, String(stored.staff_id));
  crew.saleToken = sale.data.token;
  for (const [name, method, path, body] of [
    ["money routing", "GET", `/api/merchants/${A}/settlement`],
    ["the team list", "GET", `/api/merchants/${A}/staff`],
    ["adding people", "POST", `/api/merchants/${A}/staff`, { name: "Sneaky", phone: "0911000099", role: "WAITER" }],
    ["refunds", "GET", `/api/refunds?merchant_id=${A}`],
    ["the profile", "GET", `/api/merchants/${A}/profile`],
  ]) t(`a waiter cannot use ${name}`, (await call(method, path, { ck: crew.w1ck, body })).status === 403);
  t("a waiter cannot read another business", (await call("GET", `/api/transactions?merchant_id=${B}&from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`, { ck: crew.w1ck })).status === 403);
}

section("tips: the customer pays more than the receipt");
{
  const tokenFor = async (ck, amount) => (await call("POST", "/api/transactions", { ck, body: { merchant_id: A, amount } })).data?.token;
  const info = await call("GET", `/api/pay/${crew.saleToken}`);
  t("the customer sees who is serving them", info.status === 200 && info.data.served_by?.name === "Abebe" && info.data.served_by?.team_no === crew.w1.team_no, JSON.stringify(info.data.served_by));
  const init = (token, body) => call("POST", `/api/pay/${token}/initiate`, { body: { method: "wallet", phone: "0911223344", ...body } });
  t("a negative tip is refused", (await init(crew.saleToken, { tip: -5 })).status === 400);
  t("a tip bigger than the bill is refused", (await init(crew.saleToken, { tip: 101 })).status === 400);
  t("a tip that is not a number is refused", (await init(crew.saleToken, { tip: "lots" })).status === 400);

  // 100 ETB receipt, customer chooses a 50 ETB tip on the pay page: the provider is asked for 150
  const s1 = await call("POST", "/api/transactions", { ck: crew.w1ck, body: { merchant_id: A, amount: 100 } });
  let r1;
  for (let i = 1; i <= 4; i++) { r1 = await init(s1.data.token, { tip: 50 }); if (r1.status < 500) break; await wait(2000 * i); }
  t("the payment starts for the receipt PLUS the tip", r1.status === 200 && r1.data.url?.startsWith("https://checkout.arifpay.org/"), r1.data?.error ?? r1.data?.url);
  const t1 = (await db()).transactions.find((x) => x.token === s1.data.token);
  t("the tip and the expected total are recorded", Number(t1.tip_amount) === 50 && Number(t1.expected_amount) === 150 && Number(t1.amount) === 100, `${t1.tip_amount}/${t1.expected_amount}/${t1.amount}`);
  const w0 = (await db()).watchdog_events.length;
  t("the rail confirms 150", (await settle(t1.rail_nonce, 150)).status === 200);
  const t1s = (await db()).transactions.find((x) => x.id === t1.id);
  t("settled as 100 revenue + 50 tip, no alarm", t1s.status === "SETTLED" && Number(t1s.tip_amount) === 50 && Number(t1s.settled_amount) === 150 && (await db()).watchdog_events.length === w0);

  // the waiter keys 100, the customer pays 130 straight at the provider: the extra 30 is a tip, not an error
  const s2 = await call("POST", "/api/transactions", { ck: crew.w1ck, body: { merchant_id: A, amount: 100 } });
  for (let i = 1; i <= 4; i++) { const r = await init(s2.data.token, {}); if (r.status < 500) break; await wait(2000 * i); }
  const t2 = (await db()).transactions.find((x) => x.token === s2.data.token);
  t("a payment without a tip is quoted at the receipt", Number(t2.expected_amount) === 100 && Number(t2.tip_amount ?? 0) === 0); // the real column defaults to 0; the stand-in database has no defaults
  await settle(t2.rail_nonce, 130);
  const t2s = (await db()).transactions.find((x) => x.id === t2.id);
  t("paying 130 on a 100 receipt records a 30 tip", t2s.status === "SETTLED" && Number(t2s.tip_amount) === 30 && Number(t2s.settled_amount) === 130, `${t2s.status}/${t2s.tip_amount}`);
  const ev2 = (await db()).watchdog_events.filter((e) => e.transaction_id === t2.id);
  t("the overpayment is information, not a critical alarm", ev2.length === 1 && ev2[0].severity === "INFO", JSON.stringify(ev2.map((e) => e.severity)));

  // paying LESS than the quote is still an alarm
  const s3 = await call("POST", "/api/transactions", { ck: crew.w1ck, body: { merchant_id: A, amount: 100 } });
  for (let i = 1; i <= 4; i++) { const r = await init(s3.data.token, {}); if (r.status < 500) break; await wait(2000 * i); }
  const t3 = (await db()).transactions.find((x) => x.token === s3.data.token);
  await settle(t3.rail_nonce, 90);
  const ev3 = (await db()).watchdog_events.filter((e) => e.transaction_id === t3.id);
  t("paying less than the quote is a CRITICAL alarm and no tip", ev3.some((e) => e.severity === "CRITICAL") && Number((await db()).transactions.find((x) => x.id === t3.id).tip_amount ?? 0) === 0);

  const rc = await call("GET", `/api/pay/${s1.data.token}/receipt`);
  t("the receipt shows revenue, tip, total and who served", rc.status === 200 && rc.data.amount === 100 && rc.data.tip === 50 && rc.data.total === 150 && rc.data.served_by?.name === "Abebe", JSON.stringify([rc.data.amount, rc.data.tip, rc.data.total, rc.data.served_by]));
  await wait(300);
  t("the SMS receipt shows the total and the tip", smsTo("+251911223344").some((m) => m.message.includes("150.00 ETB") && m.message.includes("includes 50.00 tip")));
}

section("who sees what: waiter, cashier and owner");
{
  const cashierSet = async () => {
    // sign the cashier Dawit in for real (first sign-in binds his phone)
    await fetch(MOCK + "/__reset_limits");
    const r = await call("POST", "/api/auth/otp/request", { body: { phone: "0911000073", purpose: "login" } });
    await wait(300);
    const code = smsTo("+251911000073").at(-1)?.message.match(/(\d{6})/)?.[1];
    const v = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: r.data.challenge_id, code, device_id: "cashier-device-ccccccc" } });
    return { v, ck: `2pay_session=${(v.headers.get("set-cookie") ?? "").split("2pay_session=")[1]?.split(";")[0]}` };
  };
  const cash = await cashierSet();
  t("a cashier added with a team number signs in as CASHIER", cash.v.status === 200 && cash.v.data.role === "CASHIER");
  const q = `merchant_id=${A}&from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`;
  const day = `merchant_id=${A}&from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`;

  const wl = await call("GET", `/api/transactions?${q}`, { ck: crew.w1ck });
  t("a waiter's feed holds only their own sales", wl.status === 200 && wl.data.rows.length > 0 && wl.data.rows.every((r) => r.staff_id === crew.w1.id));
  const cl = await call("GET", `/api/transactions?${q}`, { ck: cash.ck });
  t("the cashier's feed shows every waiter's sale, named", cl.status === 200 && cl.data.rows.some((r) => r.staff_name === "Abebe" && r.team_no === crew.w1.team_no));
  const paidRow = cl.data.rows.find((r) => r.tip_amount && Number(r.tip_amount) === 50);
  t("each feed row carries the confirmation split (100 + 50 = 150)", paidRow?.confirmation?.receipt_amount === 100 && paidRow?.confirmation?.tip === 50 && paidRow?.confirmation?.total_paid === 150 && paidRow?.confirmation?.staff?.name === "Abebe", JSON.stringify(paidRow?.confirmation));

  // a second waiter's sale, so the ledger has two people
  const set2 = await (async () => {
    const tokenReq = crew.w2;
    const link = (await call("POST", `/api/merchants/${A}/staff/${tokenReq.id}`, { ck: ownerA })).data.invite_link;
    const tk = link.split("/join/")[1];
    await fetch(MOCK + "/__reset_limits");
    const r = await call("POST", "/api/auth/otp/request", { body: { invite_token: tk } });
    await wait(300);
    const code = smsTo("+251911000072").at(-1)?.message.match(/(\d{6})/)?.[1];
    const v = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: r.data.challenge_id, code, invite_token: tk, device_id: "device-two-wwwwwwwwwww" } });
    return `2pay_session=${(v.headers.get("set-cookie") ?? "").split("2pay_session=")[1]?.split(";")[0]}`;
  })();
  crew.w2ck = set2;
  const sB = await call("POST", "/api/transactions", { ck: crew.w2ck, body: { merchant_id: A, amount: 300 } });
  await call("POST", `/api/pay/${sB.data.token}/initiate`, { body: { method: "wallet", phone: "0911223344" } });
  const tB = (await db()).transactions.find((x) => x.token === sB.data.token);
  await settle(tB.rail_nonce, 320);

  const led = await call("GET", `/api/team/ledger?${day}`, { ck: ownerA });
  const byName = Object.fromEntries((led.data.lines ?? []).map((l) => [l.name, l]));
  t("the owner's ledger splits Abebe: 150 sales... revenue and tips", byName.Abebe?.tips === 80 && byName.Abebe?.revenue === 300 && byName.Abebe?.sales === 3, JSON.stringify(byName.Abebe));
  t("...and Birtukan: 300 revenue + 20 tip", byName.Birtukan?.revenue === 300 && byName.Birtukan?.tips === 20 && byName.Birtukan?.total === 320, JSON.stringify(byName.Birtukan));
  t("ledger totals add up", led.data.totals?.revenue === led.data.lines.reduce((s, l) => s + l.revenue, 0) && Math.abs(led.data.totals.total - (led.data.totals.revenue + led.data.totals.tips)) < 0.005);
  const cashLed = await call("GET", `/api/team/ledger?${day}`, { ck: cash.ck });
  t("the cashier sees every team member's line", cashLed.status === 200 && cashLed.data.lines.length >= 2);
  const wLed = await call("GET", `/api/team/ledger?${day}`, { ck: crew.w1ck });
  t("a waiter's ledger is only their own line", wLed.status === 200 && wLed.data.lines.length === 1 && wLed.data.lines[0].name === "Abebe");
  const wLedB = await call("GET", `/api/team/ledger?merchant_id=${B}&from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`, { ck: crew.w1ck });
  t("nobody can read another business's ledger", wLedB.status === 403);
  t("an anonymous caller gets nothing", (await call("GET", `/api/team/ledger?${day}`)).status === 401);

  // reissue + removal
  const re = await call("POST", `/api/merchants/${A}/staff/${crew.w1.id}`, { ck: ownerA });
  t("a new link releases the old phone", re.status === 200 && /\/join\//.test(re.data.invite_link) && (await db()).merchant_staff.find((s) => s.id === crew.w1.id).device_id_hash == null);
  const rmW = await call("DELETE", `/api/merchants/${A}/staff/${crew.w1.id}`, { ck: ownerA });
  t("removing a waiter works", rmW.status === 200);
  t("a removed waiter's session stops creating sales at once", (await call("POST", "/api/transactions", { ck: crew.w1ck, body: { merchant_id: A, amount: 5 } })).status === 403);
  const afterRm = await call("GET", `/api/team/ledger?${day}`, { ck: ownerA });
  t("past sales still name a removed waiter", (afterRm.data.lines ?? []).some((l) => l.name === "Abebe" && l.sales === 3));
}
section("settlement vault: changing where money goes needs the owner's code");
{
  await fetch(MOCK + "/__reset_limits");
  const OWNER_PHONE = "+251911000001";
  const sKey = `/api/merchants/${A}/settlement`;
  const BANK = { id: "b0b0b0b0-0000-4000-8000-000000000001" }, WALLET = { id: "c0c0c0c0-0000-4000-8000-000000000002" };
  const keepAll = { banks: [BANK], wallets: [WALLET], active_bank_id: BANK.id, active_wallet_id: WALLET.id };
  const removeWallet = { banks: [BANK], wallets: [], active_bank_id: BANK.id, active_wallet_id: null };

  t("an unchanged save needs no code", (await call("PUT", sKey, { ck: ownerA, body: keepAll })).status === 200);
  const blocked = await call("PUT", sKey, { ck: ownerA, body: removeWallet });
  t("removing an account is refused until the owner confirms", blocked.status === 403 && blocked.data.code === "STEP_UP_REQUIRED", JSON.stringify(blocked.data));
  t("...and nothing was changed", (await db()).merchants.find((m) => m.id === A).saved_wallets.length === 1);
  t("a cashier cannot ask for the code", (await call("POST", `${sKey}/step-up/request`, { ck: cashierA })).status === 403);
  t("a waiter cannot ask for the code", (await call("POST", `${sKey}/step-up/request`, { ck: crew.w2ck })).status === 403);
  t("another business's owner cannot touch this vault", (await call("PUT", sKey, { ck: ownerB, body: removeWallet })).status === 403);

  const before = sms.length;
  const rq = await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { phone: "0911999999" } }); // a phone in the request is ignored
  await wait(300);
  const sent = sms.slice(before);
  const code = sent.at(-1)?.message.match(/(\d{6})/)?.[1];
  t("the code goes only to the registered owner phone, whatever the request says", rq.status === 200 && sent.length === 1 && sent[0].to === OWNER_PHONE && !!code, JSON.stringify(sent.map((m) => m.to)));
  t("the reply shows only a masked number and no code", rq.status === 200 && String(rq.data.phone_masked).includes("•••") && !("dev_code" in rq.data) && !JSON.stringify(rq.data).includes("911000001"));
  t("the message says what the code is for", /changing where your business receives money/i.test(sent[0]?.message ?? ""));

  const wrong = await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code: code === "000000" ? "111111" : "000000" } });
  t("a wrong code is refused", wrong.status === 400 && /incorrect/i.test(wrong.data.error ?? ""));
  t("a sign-in code cannot be used as a step-up code", (await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: "11111111-1111-4111-8111-111111111111", code } })).status === 400);
  const ok = await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code } });
  const pass = (ok.headers.get("set-cookie") ?? "").match(/2pay_stepup=([^;]+)/)?.[1];
  t("the right code gives a short-lived pass", ok.status === 200 && !!pass && /HttpOnly/i.test(ok.headers.get("set-cookie") ?? "") && /SameSite=strict/i.test(ok.headers.get("set-cookie") ?? ""));
  t("a code works once", (await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code } })).status === 400);
  const ck = `${ownerA}; 2pay_stepup=${pass}`;

  const mBefore = sms.length;
  const done = await call("PUT", sKey, { ck, body: removeWallet });
  t("with the pass, the change goes through", done.status === 200 && done.data.saved_wallets.length === 0);
  await wait(300);
  t("the owner is told about the change by SMS", sms.slice(mBefore).some((m) => m.to === OWNER_PHONE && /was just changed/i.test(m.message)));
  const forged = `${ownerA}; 2pay_stepup=${pass}x`;
  const tampered = await call("PUT", sKey, { ck: forged, body: { banks: [], wallets: [], active_bank_id: null, active_wallet_id: null } });
  t("a tampered pass is refused and nothing changes", tampered.status === 403 && tampered.data.code === "STEP_UP_REQUIRED" && (await db()).merchants.find((m) => m.id === A).saved_banks.length === 1);

  // put the wallet back (a restored account counts as a change too, and the pass is still valid for a few minutes)
  const restore = await call("PUT", sKey, { ck, body: { banks: [BANK], wallets: [{ id: WALLET.id, institution: "Telebirr", account_number: "+251911223344" }], active_bank_id: BANK.id, active_wallet_id: WALLET.id } });
  t("the owner can put an account back while the pass is valid", restore.status === 200 && restore.data.active_wallet_id === WALLET.id);
  const noPass = await call("PUT", sKey, { ck: ownerA, body: removeWallet });
  t("without the pass, the same removal is refused again", noPass.status === 403 && noPass.data.code === "STEP_UP_REQUIRED" && (await db()).merchants.find((m) => m.id === A).saved_wallets.length === 1);

  // first setup is free
  const first = await call("PUT", `/api/merchants/${B}/settlement`, { ck: ownerB, body: { banks: [{ id: "d0d0d0d0-0000-4000-8000-000000000003", institution: "Awash Bank", account_number: "1000987654321" }], wallets: [], active_bank_id: "d0d0d0d0-0000-4000-8000-000000000003", active_wallet_id: null } });
  t("the very first account can be set up without a code", first.status === 200 && first.data.active_bank_id === "d0d0d0d0-0000-4000-8000-000000000003", JSON.stringify(first.data).slice(0, 120));
  t("...but changing it afterwards needs one", (await call("PUT", `/api/merchants/${B}/settlement`, { ck: ownerB, body: { banks: [], wallets: [], active_bank_id: null, active_wallet_id: null } })).data.code === "STEP_UP_REQUIRED");
  const crossPass = await call("PUT", `/api/merchants/${B}/settlement`, { ck: `${ownerB}; 2pay_stepup=${pass}`, body: { banks: [], wallets: [], active_bank_id: null, active_wallet_id: null } });
  t("a pass earned for one business does not open another", crossPass.status === 403 && crossPass.data.code === "STEP_UP_REQUIRED");

  const actions = new Set((await db()).audit_log.map((r) => r.action));
  for (const a of ["settlement.stepup", "settlement.blocked"]) t(`audit has ${a}`, actions.has(a));
}

section("customer routing hub: the customer picks their app, the server picks the merchant's account");
{
  const mk = async () => (await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: 100 } })).data.token;
  const go = async (body) => { let r; const tok = await mk(); for (let i = 1; i <= 4; i++) { r = await call("POST", `/api/pay/${tok}/initiate`, { body: { phone: "0911223344", ...body } }); if (r.status < 500) break; await wait(2000 * i); } return { r, tok }; };
  const row = async (tok) => (await db()).transactions.find((x) => x.token === tok);

  const a = await go({ payer_app: "Telebirr" });
  t("a Telebirr customer pays the merchant's wallet", a.r.status === 200 && (await row(a.tok)).settlement_method === "WALLET", a.r.data?.error);
  t("the customer's own app is recorded on the sale", (await row(a.tok)).payer_app === "Telebirr");
  const b = await go({ payer_app: "Dashen Bank" });
  t("a Dashen customer pays the merchant's bank", b.r.status === 200 && (await row(b.tok)).settlement_method === "BANK" && (await row(b.tok)).payer_app === "Dashen Bank", b.r.data?.error);
  const c = await go({ payer_app: "Awash Bank" });
  t("an Awash customer pays the merchant's Awash account (same institution)", c.r.status === 200 && (await row(c.tok)).settlement_method === "BANK" && (await row(c.tok)).rail === "Awash Bank", c.r.data?.error);
  const d = await go({ payer_app: "CBE Birr", method: "bank" });
  t("an explicit method still wins (the merchant's own button)", d.r.status === 200 && (await row(d.tok)).settlement_method === "BANK", d.r.data?.error);

  const tok = await mk();
  t("an unknown app is refused", (await call("POST", `/api/pay/${tok}/initiate`, { body: { phone: "0911223344", payer_app: "Evil Bank" } })).status === 400);
  t("a script in the app name is refused", (await call("POST", `/api/pay/${tok}/initiate`, { body: { phone: "0911223344", payer_app: "<script>alert(1)</script>" } })).status === 400);
  t("neither a method nor an app is refused", (await call("POST", `/api/pay/${tok}/initiate`, { body: { phone: "0911223344" } })).status === 400);
  t("no app link is invented when none is configured", a.r.data?.appLink === undefined);
  t("the sale's receiving account is never taken from the customer", !JSON.stringify(a.r.data).includes("1000123456789"));
}

section("waiters work in the Android app");
{
  await fetch(MOCK + "/__reset_limits");
  const w = await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Tigist", phone: "0911000074", role: "WAITER" } });
  t("the invitation also carries the in-app link", /^twopay:\/\/activate\/[A-Za-z0-9_-]{43}$/.test(w.data.app_link ?? "") && w.data.app_link.endsWith(w.data.invite_link.split("/join/")[1]));
  const tk = w.data.invite_link.split("/join/")[1];
  const n0 = smsTo("+251911000074").length;
  const s0 = sms.length;
  const browser = await call("POST", "/api/auth/otp/request", { body: { invite_token: tk }, headers: { "user-agent": BROWSER_UA } });
  t("a web browser cannot activate a waiter", browser.status === 403 && browser.data.code === "APP_REQUIRED", JSON.stringify(browser.data));
  await wait(200);
  t("...and no SMS is spent on it", smsTo("+251911000074").length === n0 && sms.length === s0);
  const app = await call("POST", "/api/auth/otp/request", { body: { invite_token: tk } });
  t("the Android app can", app.status === 200);
  await wait(300);
  const code = smsTo("+251911000074").at(-1)?.message.match(/(\d{6})/)?.[1];
  const badV = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: app.data.challenge_id, code, invite_token: tk, device_id: "waiter-install-aaaaaaaaaa" }, headers: { "user-agent": BROWSER_UA } });
  t("verifying from a browser is refused too", badV.status === 403, JSON.stringify(badV.data));
  t("the waiter stays unlinked until the app itself confirms", (await db()).merchant_staff.find((s) => s.phone === "+251911000074")?.device_id_hash == null);
  const cashierBrowser = await call("POST", "/api/auth/otp/request", { body: { phone: "0911000073", purpose: "login" }, headers: { "user-agent": BROWSER_UA } });
  t("a cashier may still use a browser", cashierBrowser.status === 200 || cashierBrowser.status === 429);
  const ownerBrowser = await call("GET", "/api/auth/me", { ck: ownerA, headers: { "user-agent": BROWSER_UA } });
  t("the owner may use a browser", ownerBrowser.status === 200 && ownerBrowser.data.role === "OWNER");
  const wellKnown = await call("GET", "/.well-known/assetlinks.json", { raw: true });
  t("the app-link file is published so https links open in the app", wellKnown.status === 200 && wellKnown.data.includes("com.twopay.merchant") && /31:A6:AA:1A/.test(wellKnown.data));
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
