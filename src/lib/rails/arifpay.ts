import { createHmac, timingSafeEqual } from "node:crypto";
import { RailError, type PaymentRequest, type PaymentSession, type RailAdapter, type RailEvent, type RailStatus, type WebhookAuth, type WebhookInput } from "./types";
import { asNumber, asString, deepFind, eatLocalISO } from "./util";

/**
 * Arifpay adapter. Uses Arifpay's hosted checkout: we create a session and send the payer to its `paymentUrl`,
 * where the payer approves with whichever bank or wallet rail Arifpay offers; Arifpay then calls our notify URL.
 * That one integration therefore reaches every rail Arifpay supports.
 *
 * Verified against Arifpay's public sandbox (https://gateway.arifpay.org):
 *   POST /api/sandbox/c2b/session   header x-arifpay-key   ->   { error:false, data:{ sessionId, paymentUrl, ... } }
 * NOT verified (not in Arifpay's public docs): the production session path, the webhook payload and any signature
 * scheme. Those are configurable here and every raw webhook is stored in rail_events so the mapping can be
 * corrected from real callbacks. Confirm them with Arifpay before going live.
 *
 * Environment:
 *   ARIFPAY_API_KEY            required in production. In sandbox mode the published sandbox key is the default.
 *   ARIFPAY_BASE_URL           default https://gateway.arifpay.org
 *   ARIFPAY_SESSION_PATH       default /api/sandbox/c2b/session. SET THE PRODUCTION PATH from Arifpay's docs.
 *   ARIFPAY_SIM_MODE           sandbox only: SUCCESS | FAIL, forces the simulated outcome
 *   ARIFPAY_FEE_SOURCE         optional: MERCHANT | CUSTOMER (sent as x-arifpay-fee-source)
 *   ARIFPAY_DEFAULT_EMAIL      the email Arifpay requires on each session (sandbox default provided)
 *   ARIFPAY_METHOD_CODES       optional JSON {"Telebirr":"TELEBIRR",...} to restrict checkout to the chosen method
 *   ARIFPAY_BANK_CODES         optional JSON {"Awash Bank":"<code>",...}, bank codes for beneficiary splits
 *   ARIFPAY_USE_BENEFICIARIES  "true" to split funds directly to the merchant's bank account
 *   ARIFPAY_WEBHOOK_SECRET     authenticates callbacks (see verifyWebhook)
 */
const SANDBOX_KEY = "arif-sandbox-portal-key"; // published in Arifpay's sandbox Postman collection

const base = () => (process.env.ARIFPAY_BASE_URL ?? "https://gateway.arifpay.org").replace(/\/$/, "");
const sessionPath = () => process.env.ARIFPAY_SESSION_PATH ?? "/api/sandbox/c2b/session";
const isSandbox = () => sessionPath().includes("/sandbox/");
const apiKey = () => process.env.ARIFPAY_API_KEY ?? (isSandbox() ? SANDBOX_KEY : undefined);

function jsonEnv(name: string): Record<string, string> {
  try {
    const v = JSON.parse(process.env[name] ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Token we embed in the notify URL. Derived from the secret so the secret itself never travels in a URL. */
function notifyToken(secret: string): string {
  return createHmac("sha256", secret).update("2pay:arifpay:notify:v1").digest("hex").slice(0, 40);
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const SUCCESS = new Set(["SUCCESS", "SUCCESSFUL", "COMPLETED", "PAID", "SETTLED", "APPROVED"]);
const FAILURE = new Set(["FAILED", "FAILURE", "CANCELED", "CANCELLED", "EXPIRED", "ERROR", "REJECTED", "DECLINED"]);

export const arifpay: RailAdapter = {
  id: "arifpay",
  label: "Arifpay",

  notifyUrl(baseUrl) {
    const secret = process.env.ARIFPAY_WEBHOOK_SECRET;
    const url = `${baseUrl}/api/webhooks/arifpay`;
    return secret ? `${url}?k=${notifyToken(secret)}` : url;
  },

  async createPayment(req: PaymentRequest): Promise<PaymentSession> {
    const key = apiKey();
    if (!key) throw new RailError("ARIFPAY_API_KEY is not configured");
    if (!isSandbox() && !process.env.ARIFPAY_WEBHOOK_SECRET) {
      throw new RailError("ARIFPAY_WEBHOOK_SECRET must be set before taking live payments (callbacks could not be authenticated)");
    }

    const body: Record<string, unknown> = {
      cancelUrl: req.urls.cancel,
      errorUrl: req.urls.error,
      notifyUrl: req.urls.notify,
      successUrl: req.urls.success,
      phone: req.payerPhone.replace(/^\+/, ""),
      email: process.env.ARIFPAY_DEFAULT_EMAIL ?? (isSandbox() ? "sandbox@example.com" : undefined),
      nonce: req.nonce,
      expireDate: eatLocalISO(req.expiresAt),
      amount: req.amount,
      items: [{ name: `Payment to ${req.merchantName}`.slice(0, 60), quantity: 1, price: req.amount, description: `2Pay ${req.transactionId.slice(0, 8)}` }],
      lang: "EN",
    };
    if (!body.email) throw new RailError("ARIFPAY_DEFAULT_EMAIL is not configured");

    const methodCode = jsonEnv("ARIFPAY_METHOD_CODES")[req.institution];
    if (methodCode) body.paymentMethods = [methodCode];

    if (process.env.ARIFPAY_USE_BENEFICIARIES === "true" && req.method === "bank" && req.beneficiary) {
      const bankCode = jsonEnv("ARIFPAY_BANK_CODES")[req.beneficiary.institution];
      if (!bankCode) throw new RailError(`No Arifpay bank code configured for ${req.beneficiary.institution} (ARIFPAY_BANK_CODES)`);
      body.beneficiaries = [{ accountNumber: req.beneficiary.accountNumber, bank: bankCode, amount: req.amount }];
    }

    const headers: Record<string, string> = { "Content-Type": "application/json", "x-arifpay-key": key };
    if (process.env.ARIFPAY_FEE_SOURCE) headers["x-arifpay-fee-source"] = process.env.ARIFPAY_FEE_SOURCE;
    if (isSandbox() && process.env.ARIFPAY_SIM_MODE) headers["x-arifpay-sim-mode"] = process.env.ARIFPAY_SIM_MODE;

    let res: Response;
    try {
      res = await fetch(`${base()}${sessionPath()}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
    } catch (e) {
      throw new RailError(`Arifpay unreachable: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || json.error === true) {
      throw new RailError(`Arifpay rejected the session (${res.status}): ${asString(json.msg) ?? text.slice(0, 200)}`, res.status >= 500, res.status);
    }
    const sessionId = asString(deepFind(json, ["sessionId"]));
    const checkoutUrl = asString(deepFind(json, ["paymentUrl"]));
    if (!sessionId || !checkoutUrl) throw new RailError("Arifpay response had no sessionId/paymentUrl");
    if (!/^https:\/\//i.test(checkoutUrl)) throw new RailError("Arifpay returned a non-https checkout URL");
    return { sessionId, checkoutUrl };
  },

  /**
   * Arifpay's callback authentication isn't in its public docs, so two independent proofs are accepted:
   *  1. `?k=` on the notify URL we registered, which only Arifpay (and us) know, or
   *  2. an HMAC-SHA256 hex of the raw body in `x-arifpay-signature`, if Arifpay is configured to send one.
   * With no secret: open in sandbox, refused in production (fail closed).
   */
  verifyWebhook({ rawBody, headers, url }: WebhookInput): WebhookAuth {
    const secret = process.env.ARIFPAY_WEBHOOK_SECRET;
    if (!secret) return isSandbox() ? "ok" : "unconfigured";
    const k = url.searchParams.get("k");
    if (k && safeEq(k, notifyToken(secret))) return "ok";
    const sig = headers.get("x-arifpay-signature");
    if (sig && safeEq(sig.trim().toLowerCase(), createHmac("sha256", secret).update(rawBody).digest("hex"))) return "ok";
    return "bad";
  },

  parseWebhook(body: unknown): RailEvent | null {
    const statusRaw = asString(deepFind(body, ["transactionStatus", "status"]))?.toUpperCase();
    if (!statusRaw) return null;
    const status: RailStatus = SUCCESS.has(statusRaw) ? "SETTLED" : FAILURE.has(statusRaw) ? "FAILED" : "PENDING";
    return {
      status,
      nonce: asString(deepFind(body, ["nonce"])),
      sessionId: asString(deepFind(body, ["sessionId", "uuid"])),
      amount: asNumber(deepFind(body, ["amount", "totalAmount"])),
      providerRef: asString(deepFind(body, ["transactionId"])) ?? asString(deepFind(body, ["sessionId", "uuid"])),
      paymentMethod: asString(deepFind(body, ["paymentType", "paymentMethod"])),
    };
  },
};
