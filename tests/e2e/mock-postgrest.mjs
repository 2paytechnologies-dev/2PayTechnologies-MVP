// Minimal in-memory PostgREST stand-in: enough of Supabase's REST API for the 2Pay routes under test, including the
// uniqueness rules the real schema enforces. Used by tests/e2e/e2e.mjs. Not a substitute for the real database.
import http from "node:http";
import { randomUUID } from "node:crypto";

const TABLES = ["transactions", "merchants", "watchdog_events", "rail_events", "ad_impressions", "ad_campaigns", "merchant_staff", "refund_requests", "audit_log", "app_errors", "rail_attempts", "payer_contacts", "otp_challenges"];
const db = Object.fromEntries(TABLES.map((t) => [t, []]));
const counters = new Map(); // rate_limit_hit

export const A = "1f5f43ec-bbef-40da-87fe-797cd61d1e86";
export const B = "2a2a2a2a-0000-4000-8000-000000000002";
const merchant = (id, name, tid, phone, extra = {}) => ({
  id, business_name: name, category: "Fuel", terminal_id: tid, location: null, phone,
  saved_banks: [], saved_wallets: [], active_bank: null, active_wallet: null,
  kyc_status: "UNVERIFIED", static_qr_enabled: true, sms_receipts: true, tin: null, legal_name: null, business_license: null, address: null, kyc_note: null, kyc_submitted_at: null, kyc_reviewed_at: null, ...extra,
});
const bank = { id: "b0b0b0b0-0000-4000-8000-000000000001", institution: "Awash Bank", account_number: "1000123456789" };
const wallet = { id: "c0c0c0c0-0000-4000-8000-000000000002", institution: "Telebirr", account_number: "+251911223344" };
db.merchants.push(merchant(A, "NOC Station Megenagna", "TRM-0002", "+251911000001", { saved_banks: [bank], saved_wallets: [wallet], active_bank: bank, active_wallet: wallet }));
db.merchants.push(merchant(B, "Shoa Supermarket", "TRM-0003", "+251911000002", { category: "Retail", kyc_status: "VERIFIED" }));

const reserved = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function matches(row, params) {
  for (const [k, v] of params) {
    if (reserved.has(k)) continue;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot), val = v.slice(dot + 1);
    const cell = row[k];
    if (op === "eq" && String(cell) !== val) return false;
    if (op === "in") { const set = val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")); if (!set.includes(String(cell))) return false; }
    if (op === "is" && val === "null" && cell != null) return false;
    if (op === "is" && val === "true" && cell !== true) return false;
    if (op === "gte" && !(String(cell) >= val)) return false;
    if (op === "lt" && !(String(cell) < val)) return false;
    if (op === "like" && !String(cell ?? "").startsWith(val.replace(/%/g, ""))) return false;
  }
  return true;
}
const embed = (table, row, sel) => {
  if (!/merchants\(/.test(sel ?? "")) return row;
  if (table === "transactions" || table === "refund_requests" || table === "merchant_staff") return { ...row, merchants: db.merchants.find((m) => m.id === row.merchant_id) ?? null };
  return row;
};
const send = (res, code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const dup = (res, what) => send(res, 409, { code: "23505", message: `duplicate key value violates unique constraint "${what}"`, details: null });

/** The unique indexes the real schema has. */
function violates(table, item, existing) {
  if (table === "refund_requests" && ["REQUESTED", "APPROVED"].includes(item.status ?? "REQUESTED") && existing.some((r) => r.transaction_id === item.transaction_id && ["REQUESTED", "APPROVED"].includes(r.status))) return "refund_requests_open_uq";
  if (table === "merchant_staff" && existing.some((r) => r.phone === item.phone && r.active !== false)) return "merchant_staff_phone_uq";
  if (table === "merchant_staff" && item.team_no && existing.some((r) => r.merchant_id === item.merchant_id && r.team_no === item.team_no)) return "merchant_staff_team_no_uq";
  if (table === "merchant_staff" && item.invite_token_hash && existing.some((r) => r.invite_token_hash === item.invite_token_hash)) return "merchant_staff_invite_uq";
  if (table === "merchants" && item.phone && existing.some((r) => r.phone === item.phone)) return "merchants_phone_uq";
  if (table === "transactions" && item.rail_nonce && existing.some((r) => r.rail_nonce === item.rail_nonce)) return "transactions_rail_nonce_uq";
  return null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__db") return send(res, 200, db);
  // Clears only the rate-limit counters (used when a section makes many sign-in requests).
  if (u.pathname === "/__reset_limits") { counters.clear(); return send(res, 200, { ok: true }); }
  // Clears sales and rate-limit counters between sections; accounts, staff, refunds, OTPs and the audit log are kept.
  if (u.pathname === "/__reset") { for (const t of ["transactions", "rail_events", "payer_contacts", "rail_attempts", "watchdog_events", "ad_impressions", "ad_campaigns"]) db[t] = []; counters.clear(); return send(res, 200, { ok: true }); }
  const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
  const accept = req.headers.accept ?? "";
  const prefer = req.headers.prefer ?? "";
  const rep = prefer.includes("return=representation");
  const single = accept.includes("pgrst.object");

  if (rpc) {
    const b = await readBody(req);
    if (rpc[1] === "rate_limit_hit") {
      const bucket = Math.floor(Date.now() / 1000 / b.p_window_s);
      const key = `${b.p_key}|${bucket}`;
      const hits = (counters.get(key) ?? 0) + 1;
      counters.set(key, hits);
      return send(res, 200, hits <= b.p_limit);
    }
    if (rpc[1] === "open_transaction") {
      const t = db.transactions.find((x) => x.token === b.p_token);
      if (!t) return send(res, 200, []);
      if (t.status === "PENDING" && !t.viewed_at && new Date(t.expires_at) > new Date()) t.viewed_at = new Date().toISOString();
      const mm = db.merchants.find((x) => x.id === t.merchant_id);
      return send(res, 200, [{ token: t.token, amount: t.amount, currency: t.currency, status: t.status, rail: t.rail, expires_at: t.expires_at, merchant_name: mm.business_name, merchant_category: mm.category, terminal_id: mm.terminal_id, routed_bank: t.routed_bank, routed_wallet: t.routed_wallet }]);
    }
    if (rpc[1] === "authorize_transaction_v2") {
      const t = db.transactions.find((x) => x.token === b.p_token && x.status === "PENDING" && new Date(x.expires_at) > new Date());
      if (!t) return send(res, 400, { code: "P0001", message: "TOKEN_INVALID_OR_EXPIRED" });
      const r = b.p_method === "bank" ? t.routed_bank : t.routed_wallet;
      if (!r) return send(res, 400, { code: "P0001", message: "METHOD_NOT_AVAILABLE" });
      Object.assign(t, { status: "SUCCESS", rail: r.institution, settlement_method: b.p_method.toUpperCase(), latency_ms: 1500 });
      return send(res, 200, t);
    }
    return send(res, 404, { message: "unmocked rpc " + rpc[1] });
  }
  if (!m || !(m[1] in db)) return send(res, 404, { message: "unmocked " + u.pathname });
  const table = m[1];
  const sel = u.searchParams.get("select");

  if (req.method === "GET" || req.method === "HEAD") {
    let rows = db[table].filter((r) => matches(r, u.searchParams));
    const total = rows.length;
    const ord = u.searchParams.get("order");
    if (ord) { const [col, dir] = ord.split(",")[0].split("."); rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === "desc" ? -1 : 1)); }
    const lim = u.searchParams.get("limit"); const off = Number(u.searchParams.get("offset") ?? 0);
    rows = rows.slice(off, lim ? off + Number(lim) : undefined);
    const out = rows.map((r) => embed(table, r, sel));
    const hdr = { "Content-Range": `0-${Math.max(0, total - 1)}/${total}` };
    if (req.method === "HEAD") return send(res, 200, undefined, hdr);
    if (single) return out.length === 1 ? send(res, 200, out[0], hdr) : send(res, 406, { code: "PGRST116", message: "0 rows", details: `The result contains ${out.length} rows` });
    return send(res, 200, out, hdr);
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    const upsertKey = u.searchParams.get("on_conflict");
    const out = [];
    for (const b of Array.isArray(body) ? body : [body]) {
      if (upsertKey && prefer.includes("merge-duplicates")) {
        const hit = db[table].find((r) => r[upsertKey] === b[upsertKey]);
        if (hit) { Object.assign(hit, b); out.push(hit); continue; }
      }
      const item = { id: randomUUID(), created_at: new Date().toISOString(), ...(table === "transactions" ? { token: randomUUID(), currency: "ETB", status: "PENDING", rail: "EthioPay-IPS", viewed_at: null, latency_ms: null, source: "TERMINAL" } : {}), ...(table === "refund_requests" ? { status: "REQUESTED" } : {}), ...(table === "merchant_staff" ? { active: true, role: "CASHIER" } : {}), ...(table === "payer_contacts" ? { receipt_sent: false } : {}), ...b };
      const bad = violates(table, item, db[table]);
      if (bad) return dup(res, bad);
      db[table].push(item);
      out.push(item);
    }
    return rep ? send(res, 201, single ? out[0] : out) : send(res, 201, undefined);
  }
  if (req.method === "PATCH") {
    const body = await readBody(req);
    const hit = db[table].filter((r) => matches(r, u.searchParams));
    hit.forEach((r) => Object.assign(r, body));
    return rep ? (single ? (hit.length === 1 ? send(res, 200, hit[0]) : send(res, 406, { code: "PGRST116", message: "0 rows" })) : send(res, 200, hit)) : send(res, 204, undefined);
  }
  if (req.method === "DELETE") {
    const hit = db[table].filter((r) => matches(r, u.searchParams));
    db[table] = db[table].filter((r) => !hit.includes(r));
    return rep ? send(res, 200, hit) : send(res, 204, undefined);
  }
  send(res, 405, { message: "unsupported" });
}).listen(Number(process.env.MOCK_PORT ?? 4020), () => console.log("mock postgrest up"));
