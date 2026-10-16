// Minimal in-memory PostgREST stand-in: enough of Supabase's REST API for the 2Pay routes under test, including the
// uniqueness rules the real schema enforces. Used by tests/e2e/e2e.mjs. Not a substitute for the real database.
import http from "node:http";
import { randomUUID } from "node:crypto";

const TABLES = ["transactions", "merchants", "watchdog_events", "rail_events", "ad_impressions", "ad_campaigns", "merchant_staff", "refund_requests", "audit_log", "app_errors", "rail_attempts", "payer_contacts", "otp_challenges", "settlement_change_log", "ride_partners", "ride_sessions", "ride_driver_links", "ride_link_codes", "tax_settings", "fayda_sessions", "ai_event_outbox", "ai_scores"];
const db = Object.fromEntries(TABLES.map((t) => [t, []]));
db.tax_settings.push({ id: 1, rules: {}, version: 1, confirmed_by: null, confirmed_at: null, updated_at: new Date().toISOString() }); // seeded by supabase/v2_7.sql
const counters = new Map(); // rate_limit_hit

export const A = "1f5f43ec-bbef-40da-87fe-797cd61d1e86";
export const B = "2a2a2a2a-0000-4000-8000-000000000002";
const merchant = (id, name, tid, phone, extra = {}) => ({
  id, business_name: name, category: "Fuel", terminal_id: tid, location: null, phone,
  saved_banks: [], saved_wallets: [], active_bank: null, active_wallet: null,
  kind: "MERCHANT", fayda_verified: false, kyc_status: "UNVERIFIED", static_qr_enabled: true, sms_receipts: true, tin: null, legal_name: null, business_license: null, address: null, kyc_note: null, kyc_submitted_at: null, kyc_reviewed_at: null, ...extra,
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
    if (op === "lte" && !(String(cell) <= val)) return false;
    if (op === "neq" && String(cell) === val) return false;
    if (op === "ilike") { const needle = val.replace(/%/g, "").toLowerCase(); const hay = String(cell ?? "").toLowerCase(); if (val.startsWith("%") ? !hay.includes(needle) : !hay.startsWith(needle)) return false; }
    if (op === "like" && !String(cell ?? "").startsWith(val.replace(/%/g, ""))) return false;
  }
  return true;
}
const embed = (table, row, sel) => {
  let out = row;
  if (/merchants\(/.test(sel ?? "") && ["transactions", "refund_requests", "merchant_staff", "ride_partners"].includes(table)) out = { ...out, merchants: db.merchants.find((m) => m.id === row.merchant_id) ?? null };
  if (/ride_partners\(/.test(sel ?? "") && table === "ride_sessions") out = { ...out, ride_partners: db.ride_partners.find((p) => p.id === row.partner_id) ?? null };
  return out;
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
  if (table === "ride_partners" && existing.some((r) => r.key_hash === item.key_hash)) return "ride_partners_key_hash_key";
  if (table === "ride_sessions" && existing.some((r) => r.partner_id === item.partner_id && r.partner_ride_id === item.partner_ride_id)) return "ride_sessions_partner_id_partner_ride_id_key";
  if (table === "ride_sessions" && existing.some((r) => r.token_hash === item.token_hash)) return "ride_sessions_token_hash_key";
  if (table === "ride_driver_links" && existing.some((r) => r.partner_id === item.partner_id && r.driver_ref === item.driver_ref)) return "ride_driver_links_partner_id_driver_ref_key";
  if (table === "ride_link_codes" && existing.some((r) => r.code_hash === item.code_hash)) return "ride_link_codes_code_hash_key";
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
    // ---- the admin aggregates (the same arithmetic as supabase/v2_6.sql, for the tests)
    const at = (iso) => new Date(iso).getTime();
    const PAID = ["SUCCESS", "SETTLED"];
    const paidSince = (from) => db.transactions.filter((x) => PAID.includes(x.status) && at(x.created_at) >= at(from));
    const sum = (rows, f) => rows.reduce((s, r) => s + Number(f(r) ?? 0), 0);
    const confirmedEv = (id) => db.rail_events.filter((e) => e.transaction_id === id && e.signature_ok && e.applied);
    const merchantOf = (id) => db.merchants.find((m) => m.id === id) ?? {};
    if (rpc[1] === "admin_day_stats") {
      const paid = paidSince(b.p_from);
      const lat = paid.map((x) => x.latency_ms).filter((l) => l != null);
      const by = {};
      for (const x of paid) { const k = x.source ?? "TERMINAL"; (by[k] ??= []).push(x); }
      const priced = paid.filter((x) => x.base_fee != null);
      return send(res, 200, { gmv: sum(paid, (x) => x.amount), taps: paid.length, settled: paid.filter((x) => x.status === "SETTLED").length, avg_latency_ms: lat.length ? sum(lat, (l) => l) / lat.length : null,
        by_source: Object.fromEntries(Object.entries(by).map(([k, rows]) => { const l = rows.map((x) => x.latency_ms).filter((v) => v != null); return [k, { taps: rows.length, gmv: sum(rows, (x) => x.amount), avg_latency_ms: l.length ? sum(l, (v) => v) / l.length : null, nodes: new Set(rows.map((x) => x.merchant_id)).size }]; })),
        fees: { base: sum(priced, (x) => x.base_fee), vat: sum(priced, (x) => x.vat_fee), net: sum(priced, (x) => x.net_merchant_settlement), priced_taps: priced.length, legacy_taps: paid.length - priced.length } });
    }
    if (rpc[1] === "admin_node_fees") {
      const by = {};
      for (const x of paidSince(b.p_from)) (by[x.merchant_id] ??= []).push(x);
      const rows = Object.entries(by).map(([mid, list]) => ({ merchant_id: mid, business: merchantOf(mid).business_name, terminal: merchantOf(mid).terminal_id, taps: list.length, gmv: sum(list, (x) => x.amount), base: sum(list, (x) => x.base_fee), vat: sum(list, (x) => x.vat_fee), net: sum(list, (x) => x.net_merchant_settlement), legacy: list.filter((x) => x.base_fee == null).length }));
      return send(res, 200, rows.sort((a, c) => c.gmv - a.gmv).slice(0, Math.max(1, Math.min(b.p_limit ?? 25, 100))));
    }
    if (rpc[1] === "admin_compliance_summary") {
      const paid = paidSince(b.p_from);
      const conf = paid.filter((x) => confirmedEv(x.id).length);
      const flight = db.transactions.filter((x) => x.status === "PROCESSING");
      const oldest = flight.map((x) => x.processing_at).filter(Boolean).sort()[0] ?? null;
      return send(res, 200, { total: paid.length, provider_confirmed: conf.length, simulated: paid.filter((x) => !confirmedEv(x.id).length && !x.rail_provider).length, awaiting_callback: paid.filter((x) => !confirmedEv(x.id).length && x.rail_provider).length,
        in_flight: { count: flight.length, amount: sum(flight, (x) => x.amount), oldest }, mismatches: db.watchdog_events.filter((e) => e.event_type === "SETTLEMENT_MISMATCH" && at(e.created_at) >= at(b.p_from)).length });
    }
    if (rpc[1] === "admin_compliance_exceptions") {
      const out = [];
      for (const x of db.transactions.filter((y) => at(y.created_at) >= at(b.p_from))) {
        const stuck = x.status === "PROCESSING" && x.processing_at && at(x.processing_at) < Date.now() - 3600_000;
        const differs = PAID.includes(x.status) && x.settled_amount != null && Number(x.settled_amount) !== Number(x.amount);
        const unconfirmed = PAID.includes(x.status) && x.rail_provider && !confirmedEv(x.id).length;
        if (stuck || differs || unconfirmed) out.push({ id: x.id, created_at: x.created_at, business: merchantOf(x.merchant_id).business_name, terminal: merchantOf(x.merchant_id).terminal_id, amount: x.amount, settled_amount: x.settled_amount ?? null, provider: x.rail_provider ?? null, reason: stuck ? "STUCK_IN_FLIGHT" : differs ? "AMOUNT_DIFFERS" : "NO_PROVIDER_CONFIRMATION" });
      }
      return send(res, 200, out.sort((a, c) => (a.created_at < c.created_at ? 1 : -1)).slice(0, Math.max(1, Math.min(b.p_limit ?? 50, 200))));
    }
    if (rpc[1] === "admin_find_sales") {
      const q = String(b.p_q ?? "");
      let rows = db.transactions.filter((x) => PAID.includes(x.status) && at(x.created_at) >= at(b.p_from) && at(x.created_at) < at(b.p_to));
      if (b.p_before) rows = rows.filter((x) => at(x.created_at) < at(b.p_before) || (at(x.created_at) === at(b.p_before) && x.id < (b.p_before_id ?? "ffffffff")));
      if (q) rows = rows.filter((x) => x.id.startsWith(q.toLowerCase()) || String(merchantOf(x.merchant_id).terminal_id ?? "").toLowerCase().startsWith(q.toLowerCase()) || String(merchantOf(x.merchant_id).business_name ?? "").toLowerCase().includes(q.toLowerCase()));
      rows = rows.sort((a, c) => (at(a.created_at) === at(c.created_at) ? (a.id < c.id ? 1 : -1) : at(c.created_at) - at(a.created_at))).slice(0, Math.max(1, Math.min(b.p_limit ?? 25, 1000)));
      return send(res, 200, rows.map((x) => { const ev = confirmedEv(x.id); return { id: x.id, merchant_id: x.merchant_id, created_at: x.created_at, processing_at: x.processing_at ?? null, settled_at: x.settled_at ?? null, amount: x.amount, settled_amount: x.settled_amount ?? null, rail: x.rail, rail_provider: x.rail_provider ?? null, settlement_method: x.settlement_method ?? null, routed_bank: x.routed_bank ?? null, routed_wallet: x.routed_wallet ?? null, source: x.source, status: x.status, base_fee: x.base_fee ?? null, vat_fee: x.vat_fee ?? null, net_merchant_settlement: x.net_merchant_settlement ?? null, payer_app: x.payer_app ?? null, business: merchantOf(x.merchant_id).business_name, terminal: merchantOf(x.merchant_id).terminal_id, confirmed: ev.length > 0, confirmed_at: ev.map((e) => e.received_at).filter(Boolean).sort().at(-1) ?? null }; }));
    }
    if (rpc[1] === "merchant_tax_volume") {
      const month = (iso) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 7);
      const paid = db.transactions.filter((x) => x.merchant_id === b.p_merchant && PAID.includes(x.status) && at(x.created_at) >= at(b.p_from) && at(x.created_at) < at(b.p_to));
      const refs = db.refund_requests.filter((r) => r.merchant_id === b.p_merchant && r.status === "REFUNDED").map((r) => ({ r, t: db.transactions.find((x) => x.id === r.transaction_id) })).filter((x) => x.t && at(x.t.created_at) >= at(b.p_from) && at(x.t.created_at) < at(b.p_to));
      const months = [...new Set([...paid.map((x) => month(x.created_at)), ...refs.map((x) => month(x.t.created_at))])].sort();
      return send(res, 200, months.map((mo) => ({ month: mo, sales: paid.filter((x) => month(x.created_at) === mo).length, gross: sum(paid.filter((x) => month(x.created_at) === mo), (x) => x.amount), tips: sum(paid.filter((x) => month(x.created_at) === mo), (x) => x.tip_amount), refunded: sum(refs.filter((x) => month(x.t.created_at) === mo), (x) => x.r.amount) })));
    }
    if (rpc[1] === "admin_network_counts") {
      const ms = db.merchants.filter((m) => m.kind === "MERCHANT");
      const bound = db.merchant_staff.filter((s) => s.device_id_hash && s.active !== false);
      const day = db.ride_sessions.filter((s) => at(s.created_at) >= Date.now() - 86_400_000);
      return send(res, 200, { merchants: ms.length, shop_qr_stands: ms.filter((m) => m.static_qr_enabled !== false).length, app_devices: bound.length, by_role: bound.reduce((o, s) => ({ ...o, [s.role]: (o[s.role] ?? 0) + 1 }), {}), ride_partners: db.ride_partners.filter((p) => p.active !== false).length, drivers: db.merchants.filter((m) => m.kind === "DRIVER").length, linked_drivers: new Set(db.ride_driver_links.filter((l) => l.status === "ACTIVE").map((l) => l.merchant_id)).size, ride_drivers_24h: new Set(day.map((s) => s.driver_merchant_id ?? `${s.partner_id}:${s.driver_id}`)).size, ride_checkouts_24h: day.length });
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
      if (!upsertKey && prefer.includes("merge-duplicates") && b.id != null) {
        const hit = db[table].find((r) => r.id === b.id); // upsert on the primary key
        if (hit) { Object.assign(hit, b); out.push(hit); continue; }
      }
      if (upsertKey && prefer.includes("merge-duplicates")) {
        const hit = db[table].find((r) => r[upsertKey] === b[upsertKey]);
        if (hit) { Object.assign(hit, b); out.push(hit); continue; }
      }
      const item = { id: randomUUID(), created_at: new Date().toISOString(), ...(table === "transactions" ? { token: randomUUID(), currency: "ETB", status: "PENDING", rail: "EthioPay-IPS", viewed_at: null, latency_ms: null, source: "TERMINAL" } : {}), ...(table === "refund_requests" ? { status: "REQUESTED" } : {}), ...(table === "merchant_staff" ? { active: true, role: "CASHIER" } : {}), ...(table === "payer_contacts" ? { receipt_sent: false } : {}), ...(table === "ride_partners" ? { active: true, last_used_at: null, allow_partner_accounts: false } : {}), ...(table === "ride_sessions" ? { status: "OPEN", opened_at: null, paid_at: null, currency: "ETB", driver_merchant_id: null } : {}), ...(table === "fayda_sessions" ? { attempts: 0, consumed_at: null } : {}), ...(table === "merchants" ? { kind: "MERCHANT", fayda_verified: false } : {}), ...(table === "ai_event_outbox" ? { attempts: 0, sent_at: null, next_attempt_at: new Date().toISOString(), last_error: null } : {}), ...b };
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
