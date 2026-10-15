// End-to-end test of the V2.1 server flows through the REAL routes, against tests/e2e/mock-postgrest.mjs and (for one
// call) Arifpay's public SANDBOX. See tests/e2e/README.md for how to run it.
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import { startFakeFayda } from "./fake-fayda.mjs";
import { startFakeEkyc } from "./fake-ekyc.mjs";
import { signSession } from "../../src/lib/session.ts";

const BASE = process.env.BASE ?? "http://localhost:3170";
const SESSION_OK = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
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

// --- a pretend national ID provider (see fake-fayda.mjs); the app under test is started pointing at it (tests/e2e/README.md)
const fayda = await startFakeFayda({ port: 4040, clientId: "2pay-e2e", clientPrivateJwk: JSON.parse(fs.readFileSync(new URL("./fayda-client.jwk.json", import.meta.url), "utf8")), person: { sub: "uin-7000123", name: "Abebe Kebede Tesfaye", nameAm: "አበበ ከበደ ተስፋዬ" } });

// --- a pretend Fayda e-KYC gateway (FAN + code): the app under test is started with FAYDA_EKYC_URL pointing at it
const EKYC_OTP = "246810";
const FAN = "1234567812345678";
const ekyc = await startFakeEkyc({ port: 4050, key: "e2e-ekyc-key", otp: EKYC_OTP, people: { [FAN]: { name: "Bekele Girma", nameAm: "በቀለ ግርማ" }, "8765432187654321": { name: "Almaz Tadesse", nameAm: "አልማዝ ታደሰ" } } });

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
  t("CSP enforced: only our own origin for scripts, connections and form posts", /default-src 'self'/.test(p.headers.get("content-security-policy") ?? "") && /connect-src 'self'/.test(p.headers.get("content-security-policy") ?? "") && /form-action 'self'/.test(p.headers.get("content-security-policy") ?? ""));
  const evil = await call("POST", "/api/auth/logout", { headers: { origin: "https://evil.example" } });
  const evilFetch = await call("POST", "/api/auth/logout", { headers: { "sec-fetch-site": "cross-site" } });
  const ours = await call("POST", "/api/auth/logout", { headers: { origin: BASE } });
  t("a change request from another website is refused; one from our own pages is not", evil.status === 403 && evilFetch.status === 403 && ours.status !== 403, `${evil.status}/${evilFetch.status}/${ours.status}`);
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
  // 25 requests, so even if the one-minute window rolls over half way through, each half exceeds the limit of 10
  for (let i = 0; i < 25; i++) if ((await call("POST", "/api/public/terminal/TRM-0002/pay", { body: { amount: 10 } })).status === 429) limited++;
  t("rapid-fire creation is rate limited (10 per minute per payer)", limited >= 3, `${limited} of 25 refused`);
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
section("settlement vault: security key + phone code for every add and remove");
const vaultState = {};
{
  await fetch(MOCK + "/__reset_limits");
  const OWNER_PHONE = "+251911000001";
  const sKey = `/api/merchants/${A}/settlement`;
  const BANK = { id: "b0b0b0b0-0000-4000-8000-000000000001" }, WALLET = { id: "c0c0c0c0-0000-4000-8000-000000000002" };
  const keepAll = { banks: [BANK], wallets: [WALLET], active_bank_id: BANK.id, active_wallet_id: WALLET.id };
  const removeWallet = { banks: [BANK], wallets: [], active_bank_id: BANK.id, active_wallet_id: null };
  const extra = { id: "e0e0e0e0-0000-4000-8000-000000000009", institution: "Dashen Bank", account_number: "5555000011112222" };
  const addExtra = { banks: [BANK, extra], wallets: [WALLET], active_bank_id: BANK.id, active_wallet_id: WALLET.id };
  const passOf = (r) => (r.headers.get("set-cookie") ?? "").match(/2pay_stepup=([^;]+)/)?.[1];
  const codeFor = async (phone, from) => { await wait(250); return sms.slice(from).filter((m) => m.to === phone).at(-1)?.message.match(/(\d{6})/)?.[1]; };

  t("an unchanged save needs nothing", (await call("PUT", sKey, { ck: ownerA, body: keepAll })).status === 200);

  // ---- nobody can change anything until the owner has set a security key
  const noKey = await call("PUT", sKey, { ck: ownerA, body: removeWallet });
  t("removing an account is refused until a security key exists", noKey.status === 403 && noKey.data.code === "VAULT_SETUP_REQUIRED" && noKey.data.need === "pin", JSON.stringify(noKey.data));
  t("so is ADDING an account", (await call("PUT", sKey, { ck: ownerA, body: addExtra })).data.code === "VAULT_SETUP_REQUIRED");
  t("...and nothing was changed", (await db()).merchants.find((m) => m.id === A).saved_wallets.length === 1);
  const st = await call("GET", `${sKey}/vault`, { ck: ownerA });
  t("the app can ask which step is next (and learns no secret)", st.status === 200 && st.data.approver === "OWNER" && st.data.has_phone === true && st.data.has_pin === false && String(st.data.phone_masked).includes("•••") && !JSON.stringify(st.data).includes("911000001"));
  t("a cashier cannot ask", (await call("GET", `${sKey}/vault`, { ck: cashierA })).status === 403);
  t("a waiter cannot ask", (await call("GET", `${sKey}/vault`, { ck: crew.w2ck })).status === 403);

  // ---- choosing the key: a code to the owner's phone, then key + code together
  let s0 = sms.length;
  const er = await call("POST", `${sKey}/vault/enroll/request`, { ck: ownerA, body: { phone: "0911999999" } }); // a different number is ignored: the business already has one
  const ecode = await codeFor(OWNER_PHONE, s0);
  t("the code goes only to the registered owner phone", er.status === 200 && sms.slice(s0).every((m) => m.to === OWNER_PHONE) && !!ecode, JSON.stringify(sms.slice(s0).map((m) => m.to)));
  t("the reply shows only a masked number", String(er.data.phone_masked).includes("•••") && !JSON.stringify(er.data).includes("911000001") && !("dev_code" in er.data));
  const weak = await call("POST", `${sKey}/vault/enroll/verify`, { ck: ownerA, body: { challenge_id: er.data.challenge_id, code: ecode, pin: "111111" } });
  t("an easy-to-guess key is refused", weak.status === 400 && /easy to guess/i.test(weak.data.error ?? ""));
  t("a key that is not 6 digits is refused", (await call("POST", `${sKey}/vault/enroll/verify`, { ck: ownerA, body: { challenge_id: er.data.challenge_id, code: ecode, pin: "12ab56" } })).status === 400);
  t("a wrong code does not set a key", (await call("POST", `${sKey}/vault/enroll/verify`, { ck: ownerA, body: { challenge_id: er.data.challenge_id, code: ecode === "000000" ? "111111" : "000000", pin: "483920" } })).status === 400);
  const enrolled = await call("POST", `${sKey}/vault/enroll/verify`, { ck: ownerA, body: { challenge_id: er.data.challenge_id, code: ecode, pin: "483920" } });
  const pass1 = passOf(enrolled);
  const row = (await db()).merchants.find((m) => m.id === A);
  t("the key is set and the vault opens for a few minutes", enrolled.status === 200 && !!pass1);
  t("only a salted hash of the key is stored", /^scrypt\$16384\$/.test(row.vault_pin_hash ?? "") && !JSON.stringify(row).includes("483920"));
  t("the owner's phone number is unchanged", row.phone === OWNER_PHONE);
  t("a key can be chosen once; changing it needs 2Pay support", (await call("POST", `${sKey}/vault/enroll/request`, { ck: ownerA })).data.code === "VAULT_PIN_EXISTS");

  const ck = `${ownerA}; 2pay_stepup=${pass1}`;
  s0 = sms.length;
  const added = await call("PUT", sKey, { ck, body: addExtra });
  t("with the pass, an account can be ADDED", added.status === 200 && added.data.saved_banks.length === 2);
  await wait(250);
  t("the owner is told by SMS", sms.slice(s0).some((m) => m.to === OWNER_PHONE && /was just changed/i.test(m.message)));
  const stored = (await db()).merchants.find((m) => m.id === A);
  const dump = JSON.stringify([stored.saved_banks, stored.saved_wallets, stored.active_bank, stored.active_wallet]);
  t("account numbers are encrypted in the database", !dump.includes("1000123456789") && !dump.includes("5555000011112222") && /enc:v1:/.test(dump), dump.slice(0, 160));
  t("...with the last four digits kept for masking", /"last4":"2222"/.test(dump));
  t("the app still shows them masked", added.data.saved_banks.some((b) => /2222$/.test(b.account_masked)) && !JSON.stringify(added.data).includes("5555000011112222"));
  t("a pass for one approver does not work for a tampered cookie", (await call("PUT", sKey, { ck: `${ownerA}; 2pay_stepup=${pass1}x`, body: removeWallet })).data.code === "STEP_UP_REQUIRED");
  const removed = await call("PUT", sKey, { ck, body: { banks: [BANK], wallets: [], active_bank_id: BANK.id, active_wallet_id: null } });
  t("with the pass, an account can be REMOVED", removed.status === 200 && removed.data.saved_banks.length === 1 && removed.data.saved_wallets.length === 0);
  const restore = await call("PUT", sKey, { ck, body: { banks: [BANK], wallets: [{ id: WALLET.id, institution: "Telebirr", account_number: "+251911223344" }], active_bank_id: BANK.id, active_wallet_id: WALLET.id } });
  t("...and put back (the pass is still valid for three minutes)", restore.status === 200 && restore.data.active_wallet_id === WALLET.id);

  // ---- the next day: key first, then the code
  const locked = await call("PUT", sKey, { ck: ownerA, body: removeWallet });
  t("without the pass, the same change is refused again", locked.status === 403 && locked.data.code === "STEP_UP_REQUIRED" && (await db()).merchants.find((m) => m.id === A).saved_wallets.length === 1);
  s0 = sms.length;
  const wrongKey = await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { pin: "000001" } });
  await wait(250);
  t("a wrong key sends NO code (no SMS can be triggered without the key)", wrongKey.status === 400 && wrongKey.data.code === "VAULT_WRONG_KEY" && sms.length === s0 && /4 tries left/.test(wrongKey.data.error ?? ""), wrongKey.data.error);
  t("a missing key sends no code either", (await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: {} })).status === 400);
  const rq = await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { pin: "483920", phone: "0911999999" } });
  const ucode = await codeFor(OWNER_PHONE, s0);
  t("the right key sends the code, only to the registered phone", rq.status === 200 && sms.slice(s0).length === 1 && sms[s0].to === OWNER_PHONE && !!ucode && /receives money/i.test(sms[s0].message), JSON.stringify(rq.data));
  t("a sign-in code cannot be used here", (await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: "11111111-1111-4111-8111-111111111111", code: ucode } })).status === 400);
  const badCode = await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code: ucode === "000000" ? "111111" : "000000" } });
  t("a wrong code is refused", badCode.status === 400 && /incorrect/i.test(badCode.data.error ?? ""));
  const unlocked = await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code: ucode } });
  const pass2 = passOf(unlocked);
  const sc = unlocked.headers.get("set-cookie") ?? "";
  t("key + code give a short-lived pass (HttpOnly, SameSite=Strict, 3 minutes)", unlocked.status === 200 && !!pass2 && /HttpOnly/i.test(sc) && /SameSite=strict/i.test(sc) && /Max-Age=180/i.test(sc));
  t("a code works once", (await call("POST", `${sKey}/step-up/verify`, { ck: ownerA, body: { challenge_id: rq.data.challenge_id, code: ucode } })).status === 400);
  vaultState.ownerPass = pass2;

  // ---- lock-out after five wrong keys, and nothing leaks
  for (let i = 0; i < 4; i++) await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { pin: "000002" } });
  const fifth = await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { pin: "000003" } });
  t("the fifth wrong key locks the vault", fifth.status === 423 && fifth.data.code === "VAULT_LOCKED");
  const whileLocked = await call("POST", `${sKey}/step-up/request`, { ck: ownerA, body: { pin: "483920" } });
  t("even the right key is refused while it is locked", whileLocked.status === 423);
  t("the app is told how long (never the key)", (await call("GET", `${sKey}/vault`, { ck: ownerA })).data.locked_minutes > 0);
  await fetch(MOCK + "/rest/v1/merchants?id=eq." + A, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vault_failed: 0, vault_locked_until: null }) });

  // ---- who can approve at all
  t("a cashier cannot start the check", (await call("POST", `${sKey}/step-up/request`, { ck: cashierA, body: { pin: "483920" } })).status === 403);
  t("a waiter cannot start the check", (await call("POST", `${sKey}/step-up/request`, { ck: crew.w2ck, body: { pin: "483920" } })).status === 403);
  t("a cashier cannot change an account", (await call("PUT", sKey, { ck: cashierA, body: addExtra })).status === 403);
  t("a waiter cannot change an account", (await call("PUT", sKey, { ck: crew.w2ck, body: addExtra })).status === 403);
  t("another business's owner cannot touch this vault", (await call("PUT", sKey, { ck: ownerB, body: removeWallet })).status === 403);

  // ---- a business with no key: the very first account still needs the key and a phone code
  const first = await call("PUT", `/api/merchants/${B}/settlement`, { ck: ownerB, body: { banks: [{ id: "d0d0d0d0-0000-4000-8000-000000000003", institution: "Awash Bank", account_number: "1000987654321" }], wallets: [], active_bank_id: "d0d0d0d0-0000-4000-8000-000000000003", active_wallet_id: null } });
  t("the very first account also needs a security key", first.status === 403 && first.data.code === "VAULT_SETUP_REQUIRED", JSON.stringify(first.data));
  t("a pass earned for one business does not open another", (await call("PUT", `/api/merchants/${B}/settlement`, { ck: `${ownerB}; 2pay_stepup=${pass2}`, body: { banks: [{ id: "d0d0d0d0-0000-4000-8000-000000000003", institution: "Awash Bank", account_number: "1000987654321" }], wallets: [], active_bank_id: "d0d0d0d0-0000-4000-8000-000000000003", active_wallet_id: null } })).status === 403);

  const actions = new Set((await db()).audit_log.map((r) => r.action));
  for (const a of ["settlement.stepup", "settlement.blocked", "vault.enroll", "vault.key.wrong", "vault.locked"]) t(`audit has ${a}`, actions.has(a));
  t("the audit log never holds a key, a code or an account number", !JSON.stringify((await db()).audit_log).match(/483920|1000123456789|5555000011112222/));
}

section("managers: appointed approvers with their own key and phone");
{
  await fetch(MOCK + "/__reset_limits");
  const sKey = `/api/merchants/${A}/settlement`;
  const MPHONE = "+251911000075";
  const mg = await call("POST", `/api/merchants/${A}/staff`, { ck: ownerA, body: { name: "Mulu", phone: "0911000075", role: "MANAGER" } });
  t("the owner appoints a manager (team number M-…)", mg.status === 201 && mg.data.role === "MANAGER" && /^M-\d{3}$/.test(mg.data.team_no), JSON.stringify(mg.data).slice(0, 120));
  const tk = mg.data.invite_link.split("/join/")[1];
  const r0 = await call("POST", "/api/auth/otp/request", { body: { invite_token: tk } });
  await wait(250);
  const code = sms.filter((m) => m.to === MPHONE).at(-1)?.message.match(/(\d{6})/)?.[1];
  const act = await call("POST", "/api/auth/otp/verify", { body: { challenge_id: r0.data.challenge_id, code, invite_token: tk, device_id: "manager-install-mmmmmmmmm" } });
  const mck = `2pay_session=${(act.headers.get("set-cookie") ?? "").split("2pay_session=")[1]?.split(";")[0]}`;
  const payload = JSON.parse(Buffer.from(mck.split("=")[1].split(".")[0], "base64url").toString());
  t("the manager activates their own phone and signs in as MANAGER", act.status === 200 && act.data.role === "MANAGER" && payload.rl === "MANAGER" && !!payload.sid && payload.mid === A);

  const pr = await call("GET", "/api/portal", { ck: mck });
  t("the portal knows the manager", pr.status === 200 && pr.data.role === "MANAGER" && pr.data.staff?.name === "Mulu");
  t("a manager sees the payment accounts, masked", (await call("GET", sKey, { ck: mck })).status === 200);
  for (const [name, method, path, body] of [
    ["the team list", "GET", `/api/merchants/${A}/staff`],
    ["adding people", "POST", `/api/merchants/${A}/staff`, { name: "Sneaky Pete", phone: "0911000098", role: "MANAGER" }],
    ["refunds", "GET", `/api/refunds?merchant_id=${A}`],
    ["the profile", "GET", `/api/merchants/${A}/profile`],
    ["ad campaigns", "GET", `/api/ads/campaigns?merchant_id=${A}`],
  ]) t(`a manager cannot use ${name}`, (await call(method, path, { ck: mck, body })).status === 403);
  t("a manager still runs the terminal", (await call("POST", "/api/transactions", { ck: mck, body: { merchant_id: A, amount: 20 } })).status === 201);

  const extra2 = { id: "e1e1e1e1-0000-4000-8000-000000000010", institution: "Wegagen Bank", account_number: "7777000011113333" };
  const change = { banks: [{ id: "b0b0b0b0-0000-4000-8000-000000000001" }, extra2], wallets: [{ id: "c0c0c0c0-0000-4000-8000-000000000002" }], active_bank_id: "b0b0b0b0-0000-4000-8000-000000000001", active_wallet_id: "c0c0c0c0-0000-4000-8000-000000000002" };
  const blocked = await call("PUT", sKey, { ck: mck, body: change });
  t("a manager needs a key of their own first", blocked.status === 403 && blocked.data.code === "VAULT_SETUP_REQUIRED" && blocked.data.need === "pin");
  const ownerPassOnly = await call("PUT", sKey, { ck: `${mck}; 2pay_stepup=${vaultState.ownerPass}`, body: change });
  t("the OWNER's pass does not work for a manager", ownerPassOnly.status === 403);

  const s0 = sms.length;
  const me = await call("POST", `${sKey}/vault/enroll/request`, { ck: mck });
  await wait(250);
  const ecode = sms.slice(s0).filter((m) => m.to === MPHONE).at(-1)?.message.match(/(\d{6})/)?.[1];
  t("the manager's code goes to the MANAGER's phone, not the owner's", me.status === 200 && sms.slice(s0).every((m) => m.to === MPHONE) && !!ecode);
  const mv = await call("POST", `${sKey}/vault/enroll/verify`, { ck: mck, body: { challenge_id: me.data.challenge_id, code: ecode, pin: "729104" } });
  const mpass = (mv.headers.get("set-cookie") ?? "").match(/2pay_stepup=([^;]+)/)?.[1];
  t("the manager chooses their own key", mv.status === 200 && !!mpass && /^scrypt/.test((await db()).merchant_staff.find((x) => x.phone === MPHONE)?.vault_pin_hash ?? ""));
  t("the owner's key is untouched", /^scrypt/.test((await db()).merchants.find((m) => m.id === A).vault_pin_hash));

  const s1 = sms.length;
  const done = await call("PUT", sKey, { ck: `${mck}; 2pay_stepup=${mpass}`, body: change });
  await wait(250);
  t("with their key and code, a manager can add an account", done.status === 200 && done.data.saved_banks.length === 2);
  t("the OWNER is told about a change a manager made", sms.slice(s1).some((m) => m.to === "+251911000001" && /was just changed/i.test(m.message)));
  const aud = (await db()).audit_log.filter((r) => r.action === "settlement.update").at(-1);
  t("the audit log says a manager did it", aud?.details?.approver === "MANAGER" && aud?.role === "MANAGER", JSON.stringify(aud?.details));
  t("a manager's pass does not work for the owner", (await call("PUT", sKey, { ck: `${ownerA}; 2pay_stepup=${mpass}`, body: { banks: [{ id: "b0b0b0b0-0000-4000-8000-000000000001" }], wallets: [{ id: "c0c0c0c0-0000-4000-8000-000000000002" }], active_bank_id: "b0b0b0b0-0000-4000-8000-000000000001", active_wallet_id: "c0c0c0c0-0000-4000-8000-000000000002" } })).data.code === "STEP_UP_REQUIRED");
  t("removing the manager removes their power at once", (await call("DELETE", `/api/merchants/${A}/staff/${mg.data.id}`, { ck: ownerA })).status === 200 && (await call("PUT", sKey, { ck: `${mck}; 2pay_stepup=${mpass}`, body: { banks: [{ id: "b0b0b0b0-0000-4000-8000-000000000001" }], wallets: [], active_bank_id: "b0b0b0b0-0000-4000-8000-000000000001", active_wallet_id: null } })).status === 403);

  // put the business back to bank + wallet for the sections that follow
  const ownerPass = vaultState.ownerPass;
  const back = await call("PUT", sKey, { ck: `${ownerA}; 2pay_stepup=${ownerPass}`, body: { banks: [{ id: "b0b0b0b0-0000-4000-8000-000000000001" }], wallets: [{ id: "c0c0c0c0-0000-4000-8000-000000000002" }], active_bank_id: "b0b0b0b0-0000-4000-8000-000000000001", active_wallet_id: "c0c0c0c0-0000-4000-8000-000000000002" } });
  t("(the owner tidies up the extra bank)", back.status === 200 || back.status === 403);
}

section("2Pay support: reset a forgotten or locked security key");
{
  await fetch(MOCK + "/__reset_limits");
  const BPHONE = "+251911000002";
  const sKeyB = `/api/merchants/${B}/settlement`;
  const codeFor = async (phone, from) => { await wait(250); return sms.slice(from).filter((m) => m.to === phone).at(-1)?.message.match(/(\d{6})/)?.[1]; };
  // business B chooses a key, then forgets it and locks itself out
  let s0 = sms.length;
  const er = await call("POST", `${sKeyB}/vault/enroll/request`, { ck: ownerB });
  const ecode = await codeFor(BPHONE, s0);
  const en = await call("POST", `${sKeyB}/vault/enroll/verify`, { ck: ownerB, body: { challenge_id: er.data?.challenge_id, code: ecode, pin: "615243" } });
  t("(setup) a business has chosen a key", en.status === 200 && /^scrypt/.test((await db()).merchants.find((m) => m.id === B)?.vault_pin_hash ?? ""));
  for (let i = 0; i < 5; i++) await call("POST", `${sKeyB}/step-up/request`, { ck: ownerB, body: { pin: "000009" } });
  t("(setup) five wrong keys lock it", (await call("GET", `${sKeyB}/vault`, { ck: ownerB })).data?.locked_minutes > 0);

  const list = await call("GET", "/api/admin/security-keys", { ck: admin });
  const rowB = list.data?.find?.((r) => r.kind === "OWNER" && r.id === B);
  t("an admin sees who has a key and who is locked", list.status === 200 && rowB?.has_key === true && !!rowB?.locked_until, JSON.stringify(rowB));
  t("the list never contains a key or a hash", !JSON.stringify(list.data).match(/scrypt|615243|vault_pin_hash/));
  t("the owner of another business cannot list", (await call("GET", "/api/admin/security-keys", { ck: ownerA })).status === 403);
  t("nor can a cashier", (await call("GET", "/api/admin/security-keys", { ck: cashierA })).status === 403);
  t("an owner cannot reset their own key (that would defeat the second lock)", (await call("POST", "/api/admin/security-keys", { ck: ownerB, body: { kind: "OWNER", id: B, action: "reset", reason: "I forgot it, please reset" } })).status === 403);
  const post = (body, ck = admin) => call("POST", "/api/admin/security-keys", { ck, body });
  t("a reset without a written identity check is refused", (await post({ kind: "OWNER", id: B, action: "reset", reason: "ok" })).status === 400);
  t("a malformed request is refused", (await post({ kind: "ADMIN", id: B, action: "reset", reason: "called the registered number" })).status === 400 && (await post({ kind: "OWNER", id: "nope", action: "reset", reason: "called the registered number" })).status === 400);
  t("an unknown business is a 404", (await post({ kind: "OWNER", id: "9f9f9f9f-0000-4000-8000-000000000009", action: "reset", reason: "called the registered number" })).status === 404);

  s0 = sms.length;
  const reason = "Called the registered number 0911000002 and the owner confirmed the shop details";
  const reset = await post({ kind: "OWNER", id: B, action: "reset", reason });
  await wait(300);
  const afterB = (await db()).merchants.find((m) => m.id === B);
  t("an admin can reset the owner's key", reset.status === 200 && afterB.vault_pin_hash == null && afterB.vault_failed === 0 && afterB.vault_locked_until == null, JSON.stringify(reset.data));
  t("the owner is told by SMS", sms.slice(s0).some((m) => m.to === BPHONE && /reset by 2Pay support/i.test(m.message)));
  t("a second reset has nothing to do", (await post({ kind: "OWNER", id: B, action: "reset", reason })).status === 409);
  const au = (await db()).audit_log.filter((r) => r.action === "vault.key_reset").at(-1);
  t("the audit log records who, why and which business", au?.details?.reason === reason && au?.target_id === B && !!au?.actor_phone, JSON.stringify(au));
  t("the audit entry holds no key", !JSON.stringify(au).match(/615243|scrypt/));
  // the person must now choose a new key, with a code to their own phone: a reset alone changes nothing about the accounts
  const gated = await call("PUT", sKeyB, { ck: ownerB, body: { banks: [{ id: "d0d0d0d0-0000-4000-8000-000000000003", institution: "Awash Bank", account_number: "1000987654321" }], wallets: [], active_bank_id: "d0d0d0d0-0000-4000-8000-000000000003", active_wallet_id: null } });
  t("after a reset, account changes are blocked until a new key is chosen", gated.status === 403 && gated.data?.code === "VAULT_SETUP_REQUIRED");
  s0 = sms.length;
  const er2 = await call("POST", `${sKeyB}/vault/enroll/request`, { ck: ownerB });
  const ecode2 = await codeFor(BPHONE, s0);
  t("choosing a new key is allowed again, and the code goes to the owner's phone", er2.status === 200 && !!ecode2 && sms.slice(s0).every((m) => m.to === BPHONE));
  const en2 = await call("POST", `${sKeyB}/vault/enroll/verify`, { ck: ownerB, body: { challenge_id: er2.data.challenge_id, code: ecode2, pin: "902817" } });
  t("the new key works", en2.status === 200 && /^scrypt/.test((await db()).merchants.find((m) => m.id === B)?.vault_pin_hash ?? ""));

  // a manager: unlock keeps the key, reset removes it and tells both the manager and the owner
  const MPH = "+251911000076";
  const mg = await call("POST", `/api/merchants/${B}/staff`, { ck: ownerB, body: { name: "Hana", phone: "0911000076", role: "MANAGER" } });
  await fetch(MOCK + `/rest/v1/merchant_staff?id=eq.${mg.data?.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vault_pin_hash: "scrypt$16384$x$y", vault_failed: 0, vault_locked_until: new Date(Date.now() + 600000).toISOString() }) });
  const mrow = (await call("GET", "/api/admin/security-keys", { ck: admin })).data?.find?.((r) => r.kind === "MANAGER" && r.id === mg.data?.id);
  t("managers are listed with their business", mrow?.has_key === true && !!mrow?.locked_until && mrow?.merchant_id === B && /Hana/.test(mrow?.name ?? ""), JSON.stringify(mrow));
  const un = await post({ kind: "MANAGER", id: mg.data.id, action: "unlock", reason });
  const mAfterUnlock = (await db()).merchant_staff.find((x) => x.id === mg.data.id);
  t("unlock clears the lock but keeps the key", un.status === 200 && !!mAfterUnlock.vault_pin_hash && mAfterUnlock.vault_locked_until == null);
  t("unlocking something that is not locked is refused", (await post({ kind: "MANAGER", id: mg.data.id, action: "unlock", reason })).status === 409);
  s0 = sms.length;
  const mr = await post({ kind: "MANAGER", id: mg.data.id, action: "reset", reason });
  await wait(300);
  t("reset removes a manager's key", mr.status === 200 && (await db()).merchant_staff.find((x) => x.id === mg.data.id).vault_pin_hash == null);
  t("both the manager and the owner are told", sms.slice(s0).some((m) => m.to === MPH && /reset by 2Pay support/i.test(m.message)) && sms.slice(s0).some((m) => m.to === BPHONE && /reset by 2Pay support/i.test(m.message)));
  t("a reset cannot reach a manager through the owner's id or another kind", (await post({ kind: "OWNER", id: mg.data.id, action: "reset", reason })).status === 404);
  await call("DELETE", `/api/merchants/${B}/staff/${mg.data.id}`, { ck: ownerB });
}

section("pricing: the tiered fee and VAT are recorded on every sale");
{
  await fetch(MOCK + "/__reset_limits");
  const cases = [[50, 0.5, 0.075, 0.575, 49.425], [300, 0.9245, 0.1387, 1.0632, 298.9368], [1000, 1.5, 0.225, 1.725, 998.275], [7500, 2, 0.3, 2.3, 7497.7], [25000, 5, 0.75, 5.75, 24994.25]];
  for (const [amt, base, vat, total, net] of cases) {
    const r = await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: amt } });
    const row = (await db()).transactions.find((x) => x.token === r.data?.token) ?? {};
    t(`a ${amt} ETB sale records fee ${base} + VAT ${vat} = ${total}, merchant receives ${net}`, r.status === 201 && Number(row.base_fee) === base && Number(row.vat_fee) === vat && Number(row.fee_ft) === total && Number(row.net_merchant_settlement) === net, JSON.stringify({ base: row.base_fee, vat: row.vat_fee, total: row.fee_ft, net: row.net_merchant_settlement }));
    if (amt === 300) t("the new sale also carries the breakdown back to the terminal", r.data.base_fee === base && r.data.vat_fee === vat && r.data.net_merchant_settlement === net && !("payee_accounts" in r.data));
  }
  const tiny = await call("POST", "/api/transactions", { ck: ownerA, body: { merchant_id: A, amount: 0.5 } });
  t("a payment too small to cover its own fee is refused", tiny.status === 400 && tiny.data?.code === "AMOUNT_TOO_SMALL", JSON.stringify(tiny.data));
  const listed = await call("GET", `/api/transactions?${new URLSearchParams({ merchant_id: A, from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() })}`, { ck: ownerA });
  t("the merchant's ledger shows the breakdown", listed.status === 200 && listed.data.rows.some((r) => r.base_fee != null && r.vat_fee != null && r.net_merchant_settlement != null));
}

section("Fayda e-KYC by FAN and a one-time code");
{
  await fetch(MOCK + "/__reset_limits");
  const initiate = (body, ck = ownerB) => call("POST", "/api/kyc/fayda/initiate", { ck, body });
  const verify = (body, ck = ownerB) => call("POST", "/api/kyc/fayda/verify-otp", { ck, body });
  t("nobody signed in cannot start it", (await call("POST", "/api/kyc/fayda/initiate", { body: { fan: FAN } })).status === 401);
  t("a cashier cannot start it", (await initiate({ fan: FAN }, cashierA)).status === 403);
  t("a FAN that is not 16 digits is refused", (await initiate({ fan: "1234" })).status === 400 && (await initiate({})).status === 400);
  t("a FAN the national ID service does not know is refused", (await initiate({ fan: "0000000000000000" })).status === 404);

  const s1 = await initiate({ fan: FAN });
  const sess = (await db()).fayda_sessions.find((x) => x.id === s1.data?.fayda_session_id);
  t("it sends a code and returns a session id (and a masked phone), never the FAN", s1.status === 200 && !!s1.data.fayda_session_id && /•/.test(s1.data.phone_hint ?? "") && !JSON.stringify(s1.data).includes(FAN), JSON.stringify(s1.data));
  t("the FAN waits for the code encrypted, never in clear", /^enc:v1:/.test(sess?.fan_enc ?? "") && !JSON.stringify(await db()).includes(FAN.slice(0, 12)));
  t("a malformed code is refused", (await verify({ fayda_session_id: s1.data.fayda_session_id, otp: "12ab" })).status === 400);
  const wrong = await verify({ fayda_session_id: s1.data.fayda_session_id, otp: "111111" });
  t("a wrong code is refused and counted", wrong.status === 400 && /4 attempts left/.test(wrong.data?.error ?? ""), JSON.stringify(wrong.data));
  t("another business's owner cannot finish this verification", (await verify({ fayda_session_id: s1.data.fayda_session_id, otp: EKYC_OTP }, ownerA)).status === 403);
  const ok = await verify({ fayda_session_id: s1.data.fayda_session_id, otp: EKYC_OTP });
  t("the right code verifies the owner and returns the attested name", ok.status === 200 && ok.data.verified === true && ok.data.name === "Bekele Girma", JSON.stringify(ok.data));
  const m = (await db()).merchants.find((x) => x.id === B);
  t("the business is marked verified, with time and gateway transaction id", m.fayda_verified === true && !!m.fayda_verification_timestamp && !!m.fayda_verified_at && !!m.fayda_transaction_id);
  t("the FAN and the name are stored encrypted; the FAN is not in the clear anywhere", /^enc:v1:/.test(m.fayda_fan ?? "") && /^enc:v1:/.test(m.fayda_name ?? "") && !JSON.stringify(await db()).includes(FAN), m.fayda_fan?.slice(0, 20));
  t("a keyed fingerprint of the FAN is kept to recognise the same person", /^[0-9a-f]{64}$/.test(m.fayda_subject_hash ?? ""));
  const spent = (await db()).fayda_sessions.find((x) => x.id === s1.data.fayda_session_id);
  t("the request is spent and the FAN is erased from it", !!spent.consumed_at && spent.fan_enc == null);
  t("the same code cannot be used again", (await verify({ fayda_session_id: s1.data.fayda_session_id, otp: EKYC_OTP })).status === 400);
  t("a verified owner cannot start again", (await initiate({ fan: FAN })).status === 409);
  const prof = await call("GET", `/api/merchants/${B}/profile`, { ck: ownerB });
  t("the profile shows verified, with the name, and no FAN", prof.status === 200 && prof.data.fayda.verified === true && prof.data.fayda.ekyc === "gateway" && prof.data.fayda.name === "Bekele Girma" && !JSON.stringify(prof.data).includes(FAN), JSON.stringify(prof.data.fayda));
  const acts = new Set((await db()).audit_log.map((r) => r.action));
  t("the audit log records the request and the verification, without the FAN", acts.has("kyc.fayda.initiate") && acts.has("kyc.fayda.verified") && !JSON.stringify((await db()).audit_log).includes(FAN));

  // five wrong codes lock a request (business A, which is verified later through the other route)
  const a1 = await initiate({ fan: "8765432187654321" }, ownerA);
  let last;
  for (let i = 0; i < 5; i++) last = await verify({ fayda_session_id: a1.data.fayda_session_id, otp: "000000" }, ownerA);
  const after = await verify({ fayda_session_id: a1.data.fayda_session_id, otp: EKYC_OTP }, ownerA);
  t("five wrong codes spend the request, even the right code is then refused", last.status === 400 && after.status === 429 && after.data?.code === "FAYDA_TOO_MANY", JSON.stringify(after.data));
  t("a business that failed is not marked verified", (await db()).merchants.find((x) => x.id === A).fayda_verified !== true);
}

section("ride-hailing: a driver is paid for a finished trip");
{
  await fetch(MOCK + "/__reset_limits");
  const BASEP = "/api/v1/integrations/ride-hailing/session";
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
  const create = (body, key) => call("POST", BASEP, { headers: auth(key), body });
  const mint = (tok) => call("POST", `${BASEP}/mint`, { body: { session_token: tok } });
  const status = (tok, extra = "") => call("GET", `${BASEP}/status?session_token=${tok}${extra}`);

  // ---- the partner and its key
  t("an owner cannot create a ride partner", (await call("POST", "/api/admin/ride-partners", { ck: ownerA, body: { name: "Feres", merchant_id: A } })).status === 403);
  t("a partner needs a name and a merchant", (await call("POST", "/api/admin/ride-partners", { ck: admin, body: { name: "x", merchant_id: A } })).status === 400 && (await call("POST", "/api/admin/ride-partners", { ck: admin, body: { name: "Feres" } })).status === 400);
  const mk = await call("POST", "/api/admin/ride-partners", { ck: admin, body: { name: "Feres", merchant_id: A } });
  const KEY = mk.data?.api_key;
  t("an admin creates a partner and is shown its API key once", mk.status === 201 && /^2pay_rk_[A-Za-z0-9_-]{43}$/.test(KEY ?? ""));
  t("only a hash of the key is stored, and the key is nowhere else", !JSON.stringify(await db()).includes(KEY) && (await db()).ride_partners.some((p) => p.key_hash === sha(KEY)));
  const plist = await call("GET", "/api/admin/ride-partners", { ck: admin });
  t("the partner list shows a hint, never the key", plist.status === 200 && plist.data.some((p) => p.name === "Feres" && p.key_hint === KEY.slice(-4)) && !JSON.stringify(plist.data).includes(KEY));
  t("an owner cannot read the partner list", (await call("GET", "/api/admin/ride-partners", { ck: ownerA })).status === 403);

  // ---- a partner starts a checkout
  const intent = { partner_ride_id: "RIDE-1001", driver_id: "drv-77", fare_amount: 250, currency: "ETB", driver_wallet_accounts: [{ rail: "TELEBIRR", account_number: "0911223344" }, { rail: "CBE_BIRR", account_number: "0922334455" }, { rail: "AWASH", account_number: "01320123456789" }] };
  t("no key: refused", (await create(intent)).status === 401);
  t("a wrong key: refused", (await create(intent, "2pay_rk_" + "x".repeat(43))).status === 401);
  t("a fare of zero is refused", (await create({ ...intent, fare_amount: 0 }, KEY)).status === 400);
  t("an unknown rail is refused", (await create({ ...intent, driver_wallet_accounts: [{ rail: "NOPE", account_number: "0911223344" }] }, KEY)).status === 400);
  t("a fare too small to cover its fee is refused", (await create({ ...intent, partner_ride_id: "tiny", fare_amount: 0.5 }, KEY)).data?.code === "AMOUNT_TOO_SMALL");

  const c1 = await create(intent, KEY);
  const TOK = c1.data?.session_token;
  t("a checkout is created with the fare, the driver link and the fee breakdown", c1.status === 201 && SESSION_OK(TOK) && c1.data.fare.amount === 250 && c1.data.pricing.total_fee === 1.0447 && c1.data.pricing.net_driver_settlement === 248.9553, JSON.stringify(c1.data).slice(0, 200));
  t("the reply has the app deep link, the Android intent and the web terminal link", c1.data.deep_link === `twopay://checkout?token=${TOK}` && c1.data.terminal_url.endsWith(`/terminal?session_token=${TOK}`) && c1.data.android_intent.startsWith("intent://checkout") && c1.data.android_intent.includes("package=com.twopay.merchant"));
  t("the driver's accounts are returned masked only", c1.data.payout_accounts.length === 3 && !JSON.stringify(c1.data).match(/0911223344|922334455|01320123456789/));
  const srow = (await db()).ride_sessions.find((x) => x.id === c1.data.session_id);
  t("the link is stored as a hash, the accounts encrypted", srow.token_hash === sha(TOK) && !JSON.stringify(srow).includes(TOK) && /enc:v1:/.test(JSON.stringify(srow.accounts)) && !JSON.stringify(srow.accounts).match(/911223344|922334455|1320123456789/));

  // ---- safe to retry
  const c2 = await create(intent, KEY);
  const TOK2 = c2.data?.session_token;
  t("the same ride sent again is the same ride, with a fresh link", c2.status === 200 && c2.data.session_id === c1.data.session_id && TOK2 !== TOK);
  t("the old link stops working", (await mint(TOK)).status === 404);
  t("the same ride for a different driver is refused", (await create({ ...intent, driver_id: "someone-else" }, KEY)).data?.code === "DRIVER_MISMATCH");

  // ---- the driver's phone
  t("a malformed link is refused", (await mint("nope")).status === 400);
  const page = await call("GET", `/terminal?session_token=${TOK2}`, { raw: true });
  t("the checkout page opens on the driver's phone with no sign-in", page.status === 200);
  t("the plain terminal still needs a sign-in", [307, 308].includes((await call("GET", "/terminal", { raw: true })).status));
  const m1 = await mint(TOK2);
  const row = (await db()).transactions.find((x) => x.token === m1.data?.token) ?? {};
  t("the driver's phone gets a pay node for the fare", m1.status === 201 && m1.data.amount === 250 && m1.data.source === "RIDE" && m1.data.ride?.partner === "Feres", JSON.stringify(m1.data).slice(0, 160));
  t("the sale pays the driver's accounts, stored encrypted and never sent back", !("payee_accounts" in m1.data) && /enc:v1:/.test(JSON.stringify(row.payee_accounts)) && !JSON.stringify(row.payee_accounts).match(/911223344|922334455|1320123456789/) && row.ride_session_id === c1.data.session_id && row.merchant_id === A);
  t("the sale carries the fee breakdown", Number(row.base_fee) === 0.9084 && Number(row.vat_fee) === 0.1363 && Number(row.fee_ft) === 1.0447 && Number(row.net_merchant_settlement) === 248.9553);

  // ---- the passenger's phone
  const pg = await call("GET", `/api/pay/${m1.data.token}`);
  t("the passenger sees the driver's accounts (masked)", pg.status === 200 && pg.data.tx.payee_options?.length === 3 && pg.data.tx.payee_options.some((o) => o.institution === "CBE Birr" && /3455$|4455$/.test(o.account_masked)) && !JSON.stringify(pg.data).match(/0911223344|922334455|01320123456789/), JSON.stringify(pg.data.tx.payee_options));
  t("an account that is not the driver's is refused", (await call("POST", `/api/pay/${m1.data.token}/initiate`, { body: { account_id: "9f9f9f9f-0000-4000-8000-000000000009", phone: "0911223344" } })).status === 400);

  const s0 = await status(TOK2);
  t("before payment the driver's phone sees an open ride", s0.status === 200 && s0.data.status === "OPEN" && s0.data.paid === null && !!s0.headers.get("x-status-sig"));
  let init;
  for (let attempt = 1; attempt <= 4; attempt++) {
    init = await call("POST", `/api/pay/${m1.data.token}/initiate`, { body: { payer_app: "Telebirr", phone: "0911223344", lang: "en" } });
    if (init.status < 500) break;
    console.log(`  (sandbox answered ${init.status}; retrying ${attempt}/3)`);
    await wait(2000 * attempt);
  }
  const prow = (await db()).transactions.find((x) => x.token === m1.data.token);
  t("tapping Telebirr routes to the driver's Telebirr account and starts the payment", init.status === 200 && init.data.mode === "redirect" && prow.rail === "Telebirr" && prow.routed_wallet?.institution === "Telebirr" && prow.routed_bank == null && prow.status === "PROCESSING", JSON.stringify(init.data).slice(0, 160));
  const s1b = await status(TOK2);
  t("the driver's phone sees the passenger paying", s1b.data.processing === true && s1b.data.status === "OPEN");

  // the payment clears while the driver's phone is holding a request open: it must be answered at once
  const sig1 = s1b.headers.get("x-status-sig");
  const t0 = Date.now();
  const held = status(TOK2, `&wait=7&sig=${encodeURIComponent(sig1)}`);
  await wait(500);
  const settled = await settle(prow.rail_nonce, 250);
  const h = await held;
  t("the payment clears and the held request is answered within a moment", settled.status === 200 && h.data?.status === "PAID" && !!h.data.paid && Date.now() - t0 < 4000, `${Date.now() - t0} ms ${JSON.stringify(h.data)?.slice(0, 120)}`);
  t("the answer never carries the rail's internals or the driver's accounts", !JSON.stringify(h.data).match(/rail_nonce|rail_session|rail_checkout|payee_accounts|enc:v1/));

  // ---- what the partner sees
  const view = await call("GET", `${BASEP}/${c1.data.session_id}`, { headers: auth(KEY) });
  t("the partner sees the ride paid, with the fee breakdown", view.status === 200 && view.data.status === "PAID" && view.data.payment?.paid_via === "Telebirr" && view.data.payment.base_fee === 0.9084 && view.data.payment.vat_fee === 0.1363 && view.data.payment.total_fee === 1.0447 && view.data.payment.net_driver_settlement === 248.9553, JSON.stringify(view.data));
  const byRide = await call("GET", `${BASEP}?partner_ride_id=RIDE-1001`, { headers: auth(KEY) });
  t("...and can look a ride up by its own id", byRide.status === 200 && byRide.data.session_id === c1.data.session_id && byRide.data.status === "PAID");
  t("a paid ride cannot be sent again or minted again", (await create(intent, KEY)).data?.code === "ALREADY_PAID" && (await mint(TOK2)).data?.code === "ALREADY_PAID");
  t("a paid ride cannot be cancelled", (await call("DELETE", `${BASEP}/${c1.data.session_id}`, { headers: auth(KEY) })).status === 409);
  const ledger = await call("GET", `/api/transactions?${new URLSearchParams({ merchant_id: A, from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() })}`, { ck: ownerA });
  const ride = ledger.data.rows.find((r) => r.source === "RIDE");
  t("the ride is in the partner merchant's ledger, with no stored driver accounts", !!ride && ride.net_merchant_settlement != null && !("payee_accounts" in ride) && !JSON.stringify(ledger.data).match(/enc:v1/));

  // ---- other partners, cancelling, expiry, disabling, rotating
  const mk2 = await call("POST", "/api/admin/ride-partners", { ck: admin, body: { name: "RIDE", merchant_id: B } });
  t("another partner cannot see this partner's ride", (await call("GET", `${BASEP}/${c1.data.session_id}`, { headers: auth(mk2.data.api_key) })).status === 404);
  const c3 = await create({ ...intent, partner_ride_id: "RIDE-1002", fare_amount: 120 }, KEY);
  const cancel = await call("DELETE", `${BASEP}/${c3.data.session_id}`, { headers: auth(KEY) });
  t("a partner can cancel an unpaid ride", cancel.status === 200 && cancel.data.status === "CANCELLED");
  const mc = await mint(c3.data.session_token);
  t("a cancelled ride's link stops working", mc.status === 410 && mc.data.code === "SESSION_CANCELLED");
  const c4 = await create({ ...intent, partner_ride_id: "RIDE-1003", fare_amount: 80 }, KEY);
  await fetch(MOCK + `/rest/v1/ride_sessions?id=eq.${c4.data.session_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
  const me = await mint(c4.data.session_token);
  t("an expired link is refused", me.status === 410 && me.data.code === "SESSION_EXPIRED");
  t("an expired ride shows as expired to the partner", (await call("GET", `${BASEP}/${c4.data.session_id}`, { headers: auth(KEY) })).data.status === "EXPIRED");

  const c5 = await create({ ...intent, partner_ride_id: "RIDE-1004", fare_amount: 60 }, KEY);
  const pid = (await db()).ride_partners.find((p) => p.name === "Feres").id;
  t("an admin can switch a partner off", (await call("PATCH", "/api/admin/ride-partners", { ck: admin, body: { id: pid, active: false } })).status === 200);
  t("a switched-off partner's key stops working at once", (await create({ ...intent, partner_ride_id: "RIDE-1005" }, KEY)).status === 401);
  t("...and the links it already gave out stop too", (await mint(c5.data.session_token)).status === 404);
  await call("PATCH", "/api/admin/ride-partners", { ck: admin, body: { id: pid, active: true } });
  const rot = await call("PATCH", "/api/admin/ride-partners", { ck: admin, body: { id: pid, rotate: true } });
  t("rotating a key shows the new one once and kills the old one", rot.status === 200 && /^2pay_rk_/.test(rot.data.api_key) && (await create({ ...intent, partner_ride_id: "RIDE-1006" }, KEY)).status === 401 && (await create({ ...intent, partner_ride_id: "RIDE-1006" }, rot.data.api_key)).status === 201);
  const acts2 = new Set((await db()).audit_log.map((r) => r.action));
  for (const a of ["ride.partner.create", "ride.session.create", "ride.session.update", "ride.session.cancel", "ride.partner.disable", "ride.partner.rotate"]) t(`audit has ${a}`, acts2.has(a));
  t("the audit log never holds an API key, a checkout link or a full account number", !JSON.stringify((await db()).audit_log).match(new RegExp(`${KEY}|${rot.data.api_key}|${TOK2}|0911223344|0922334455|01320123456789`)));
}

section("national ID (Fayda): prove the owner is who they say");
{
  await fetch(MOCK + "/__reset_limits");
  const startUrl = `/api/merchants/${A}/fayda/start`;
  const cookieOf = (r, name) => (r.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1];
  t("a cashier cannot start it", (await call("POST", startUrl, { ck: cashierA })).status === 403);
  t("a waiter cannot start it", (await call("POST", startUrl, { ck: crew.w2ck })).status === 403);
  t("another business's owner cannot start it for this one", (await call("POST", startUrl, { ck: ownerB })).status === 403);

  const st = await call("POST", startUrl, { ck: ownerA, body: { lang: "am" } });
  const fc = cookieOf(st, "2pay_fayda");
  const au = new URL(st.data.url ?? "http://x");
  t("it hands the browser the provider's sign-in address (standard OpenID Connect with PKCE)", st.status === 200 && au.origin === "http://localhost:4040" && au.searchParams.get("code_challenge_method") === "S256" && au.searchParams.get("client_id") === "2pay-e2e" && au.searchParams.get("ui_locales") === "am" && !!au.searchParams.get("nonce"));
  t("the state cookie is HttpOnly, signed, short-lived and scoped to the callback", /HttpOnly/i.test(st.headers.get("set-cookie") ?? "") && /Path=\/api\/fayda/i.test(st.headers.get("set-cookie") ?? "") && /Max-Age=600/i.test(st.headers.get("set-cookie") ?? "") && !!fc);
  t("no verifier or key ever reaches the browser in the body", !JSON.stringify(st.data).includes("verifier") && !JSON.stringify(st.data).includes("BEGIN"));

  // the person signs in at the provider (the pretend one approves at once) and is sent back
  const toIdp = await fetch(st.data.url, { redirect: "manual" });
  const back = new URL(toIdp.headers.get("location"));
  const callbackPath = back.pathname + back.search;
  t("the provider sends them back to 2Pay's callback with a code and our state", toIdp.status === 302 && back.pathname === "/api/fayda/callback" && !!back.searchParams.get("code") && back.searchParams.get("state") === au.searchParams.get("state"));

  const wrongState = await call("GET", callbackPath.replace(/state=[^&]+/, "state=forged"), { ck: `${ownerA}; 2pay_fayda=${fc}`, raw: true });
  t("a forged state does nothing", wrongState.status === 307 && /fayda=error/.test(wrongState.headers.get("location") ?? ""));
  t("...and verified nothing", (await db()).merchants.find((m) => m.id === A).fayda_verified_at == null);
  const noCookie = await call("GET", callbackPath, { ck: ownerA, raw: true });
  t("a callback without our cookie does nothing", /fayda=error/.test(noCookie.headers.get("location") ?? ""));
  const otherPerson = await call("GET", callbackPath, { ck: `${ownerB}; 2pay_fayda=${fc}`, raw: true });
  t("a different signed-in person cannot complete someone else's check", /fayda=error/.test(otherPerson.headers.get("location") ?? ""));

  const tIdp = await fetch(st.data.url, { redirect: "manual" }); // a fresh code (the one above was never spent)
  const back2 = new URL(tIdp.headers.get("location"));
  const ok = await call("GET", back2.pathname + back2.search, { ck: `${ownerA}; 2pay_fayda=${fc}`, raw: true });
  t("the real return verifies the owner and lands back on the profile", [302, 307].includes(ok.status) && /fayda=ok/.test(ok.headers.get("location") ?? "") && /tab=profile/.test(ok.headers.get("location") ?? ""), ok.headers.get("location") ?? "");
  const m = (await db()).merchants.find((x) => x.id === A);
  t("the check is recorded", !!m.fayda_verified_at);
  t("only a keyed fingerprint of the national ID is kept, never the ID", /^[0-9a-f]{64}$/.test(m.fayda_subject_hash ?? "") && !JSON.stringify(m).includes("uin-7000123"));
  t("the name is stored encrypted", /^enc:v1:/.test(m.fayda_name ?? "") && !JSON.stringify(m).includes("Abebe Kebede Tesfaye"));
  t("the code was exchanged using our signed assertion and PKCE (the provider checked both)", fayda.seen.tokenCalls >= 1 && fayda.seen.rejected.length === 0, JSON.stringify(fayda.seen.rejected));
  const prof = await call("GET", `/api/merchants/${A}/profile`, { ck: ownerA });
  t("the profile shows who was verified (English name) and that the provider is on", prof.status === 200 && prof.data.fayda.configured === true && prof.data.fayda.name === "Abebe Kebede Tesfaye" && !!prof.data.fayda_verified_at && !("fayda_name" in prof.data));
  const replay = await call("GET", back2.pathname + back2.search, { ck: `${ownerA}; 2pay_fayda=${fc}`, raw: true });
  t("a returned code cannot be replayed", /fayda=error/.test(replay.headers.get("location") ?? "") && fayda.seen.rejected.some((x) => /reused/.test(x)));
  const cancelled = await call("GET", "/api/fayda/callback?error=access_denied", { ck: `${ownerA}; 2pay_fayda=${fc}`, raw: true });
  t("cancelling at the provider is handled", /fayda=cancelled/.test(cancelled.headers.get("location") ?? ""));
  t("the TIN is encrypted in the database too", /^enc:v1:/.test((await db()).merchants.find((x) => x.id === A).tin ?? ""));
  const kyc = await call("GET", "/api/admin/kyc?status=VERIFIED", { ck: admin });
  t("an admin reviewing KYC still sees the TIN, decrypted on the server", kyc.status === 200 && kyc.data.some((r) => r.id === A && /^\d{10}$/.test(String(r.tin))), JSON.stringify(kyc.data?.map?.((r) => r.tin)));
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
section("instant payment detection: held requests answer when the sale changes");
{
  const s = await liveSale(ownerA, 55);
  const H = { headers: { cookie: ownerA } };
  const first = await fetch(BASE + `/api/transactions/status?tokens=${s.token}`, H);
  const sig = first.headers.get("x-status-sig") ?? "";
  t("the status answer carries a signature of the sale's state", first.status === 200 && sig.length > 10 && !!s.nonce);

  // 1) the terminal's own sale: held for up to 6 s, answered right after the rail confirms
  const day = `merchant_id=${A}&from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`;
  const feed0 = await fetch(BASE + `/api/transactions?${day}&limit=30`, { headers: { cookie: ownerA } });
  const feedSig = feed0.headers.get("x-feed-sig") ?? "";
  const heldStatus = fetch(BASE + `/api/transactions/status?tokens=${s.token}&wait=6&sig=${encodeURIComponent(sig)}`, H).then(async (r) => ({ rows: await r.json(), at: Date.now() }));
  const heldFeed = fetch(BASE + `/api/transactions?${day}&limit=30&wait=6&sig=${encodeURIComponent(feedSig)}`, { headers: { cookie: ownerA } }).then(async (r) => ({ body: await r.json(), at: Date.now() }));
  await wait(800);
  const settledAt = Date.now();
  await settle(s.nonce, 55);
  const hs = await heldStatus;
  const hf = await heldFeed;
  t("the held status request answers right after the payment clears (about 0.2 s; the bound allows for a cold dev server)", hs.at - settledAt < 2500 && hs.at - settledAt >= 0, `${hs.at - settledAt} ms`);
  t("...and says the sale is paid", hs.rows[0]?.status === "SETTLED");
  t("the held sales feed also answers right after it clears", hf.at - settledAt < 2500, `${hf.at - settledAt} ms`);
  t("...and lists the new sale as settled", hf.body.rows.some((r) => r.id === s.id && r.status === "SETTLED"));

  // 2) nothing changes: the request is held, then answered with the same state
  const curSig = (await fetch(BASE + `/api/transactions/status?tokens=${s.token}`, H)).headers.get("x-status-sig") ?? "";
  const t0 = Date.now();
  const idle = await fetch(BASE + `/api/transactions/status?tokens=${s.token}&wait=1&sig=${encodeURIComponent(curSig)}`, H);
  const waited = Date.now() - t0;
  t("with nothing new, the server holds the request for the wait time and no longer", idle.status === 200 && waited >= 900 && waited < 2500, `${waited} ms`);
  t("a malformed wait is harmless", (await fetch(BASE + `/api/transactions/status?tokens=${s.token}&wait=banana`, H)).status === 200);
  const t1 = Date.now();
  const capped = await fetch(BASE + `/api/transactions/status?tokens=${s.token}&wait=9999&sig=${encodeURIComponent(curSig)}`, H);
  t("the wait is capped (a huge number does not hold a connection for minutes)", capped.status === 200 && Date.now() - t1 < 9500, `${Date.now() - t1} ms`);
}
section("one-request bootstrap for the portal");
{
  const anon = await call("GET", "/api/portal");
  t("an anonymous caller gets nothing when sign-in is enforced", anon.status === 401);
  const own = await call("GET", "/api/portal", { ck: ownerA });
  t("the owner gets session, own business and default in ONE answer", own.status === 200 && own.data.role === "OWNER" && own.data.defaultMerchantId === A && own.data.merchants.length === 1 && own.data.merchants[0].id === A && own.data.merchant?.id === A);
  t("it names the active institutions but never an account number", own.status === 200 && own.data.merchants[0].routing && !JSON.stringify(own.data).includes("1000123456789") && !JSON.stringify(own.data).includes("911223344"));
  t("it is never cached by a shared cache", /private/.test(own.headers.get("cache-control") ?? "") && /no-store/.test(own.headers.get("cache-control") ?? ""));
  const adminP = await call("GET", "/api/portal", { ck: admin });
  t("an admin sees every business", adminP.status === 200 && adminP.data.admin === true && adminP.data.merchants.length >= 2);
  const w = await call("GET", "/api/portal", { ck: crew.w2ck });
  t("a waiter's answer carries their name and team number", w.status === 200 && w.data.role === "WAITER" && w.data.staff?.name === "Birtukan" && !!w.data.staff?.team_no);
  const me = await call("GET", "/api/auth/me", { ck: ownerA });
  t("the session answer is private too", /private/.test(me.headers.get("cache-control") ?? ""));
  t("every API answer is private by default", /private/.test((await call("GET", "/api/health")).headers.get("cache-control") ?? ""));
  const asset = await call("GET", "/sounds/paid-am.mp3", { raw: true });
  t("the recorded Amharic word is cached for a year", /max-age=31536000/.test(asset.headers.get("cache-control") ?? ""));
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
