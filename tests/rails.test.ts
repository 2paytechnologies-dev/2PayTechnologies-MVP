import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { arifpay } from "@/lib/rails/arifpay";
import { candidatesFor, EMPTY_HEALTH, isUnhealthy, parseRouting, rankProviders } from "@/lib/rails/router";

const saved = { ...process.env };
const reset = () => {
  for (const k of Object.keys(process.env)) if (k.startsWith("ARIFPAY_")) delete process.env[k];
};
beforeEach(reset);
afterEach(() => {
  reset();
  Object.assign(process.env, saved);
});

// The REAL response Arifpay's sandbox returned for a direct transfer (trimmed to the fields that matter).
const sandboxReal = {
  error: false,
  msg: "Sandbox payment successful",
  data: {
    transaction: {
      id: 113334,
      checkoutSession: { uuid: "1F035F80D757", nonce: "probe2_1791752670_44056660", totalAmount: 10.0 },
      transactionId: "SIM-747ae48f-3f39-4913-a147-9b9c8ba600fe",
      transactionStatus: "SUCCESS",
      paymentType: "CBE",
      amount: 10.0,
      fee: 0.288,
    },
    sessionId: "1F035F80D757",
  },
};

describe("arifpay callback parsing", () => {
  it("reads the real sandbox shape", () => {
    expect(arifpay.parseWebhook(sandboxReal)).toEqual({
      status: "SETTLED",
      nonce: "probe2_1791752670_44056660",
      sessionId: "1F035F80D757",
      amount: 10,
      providerRef: "SIM-747ae48f-3f39-4913-a147-9b9c8ba600fe",
      paymentMethod: "CBE",
    });
  });
  it("reads a flat payload", () => {
    expect(arifpay.parseWebhook({ nonce: "n1", transactionStatus: "SUCCESS", totalAmount: 25, sessionId: "S", paymentMethod: "TELEBIRR" })?.status).toBe("SETTLED");
  });
  it("maps failures, unknowns and casing", () => {
    for (const s of ["FAILED", "CANCELED", "EXPIRED", "DECLINED"]) expect(arifpay.parseWebhook({ nonce: "n", transactionStatus: s })?.status).toBe("FAILED");
    expect(arifpay.parseWebhook({ nonce: "n", transactionStatus: "PROCESSING" })?.status).toBe("PENDING");
    expect(arifpay.parseWebhook({ nonce: "n", transactionStatus: "success" })?.status).toBe("SETTLED");
  });
  it("ignores payloads with no payment status", () => {
    expect(arifpay.parseWebhook({ nonce: "n" })).toBeNull();
    expect(arifpay.parseWebhook("hello")).toBeNull();
    expect(arifpay.parseWebhook(null)).toBeNull();
  });
  it("coerces numeric strings", () => {
    expect(arifpay.parseWebhook({ nonce: "n", transactionStatus: "SUCCESS", amount: "12.50" })?.amount).toBe(12.5);
  });
});

describe("arifpay callback authenticity", () => {
  const url = (q = "") => new URL("https://x.test/api/webhooks/arifpay" + q);
  const body = '{"nonce":"abc","transactionStatus":"SUCCESS"}';

  it("is open only in the sandbox, and FAILS CLOSED in production with no secret", () => {
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers(), url: url() })).toBe("ok");
    process.env.ARIFPAY_SESSION_PATH = "/api/prod/c2b/session";
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers(), url: url() })).toBe("unconfigured");
  });
  it("accepts the derived ?k= token and an HMAC header, and rejects anything else", () => {
    process.env.ARIFPAY_WEBHOOK_SECRET = "s3cret-s3cret-s3cret-s3cret-0000";
    const notify = arifpay.notifyUrl("https://pay.example.com");
    const k = new URL(notify).searchParams.get("k")!;
    expect(notify.includes("s3cret")).toBe(false); // the secret itself never travels in a URL
    expect(k).toHaveLength(40);
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers(), url: url(`?k=${k}`) })).toBe("ok");
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers(), url: url(`?k=${"0".repeat(40)}`) })).toBe("bad");
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers(), url: url() })).toBe("bad");
    const sig = createHmac("sha256", process.env.ARIFPAY_WEBHOOK_SECRET).update(body).digest("hex");
    expect(arifpay.verifyWebhook({ rawBody: body, headers: new Headers({ "x-arifpay-signature": sig }), url: url() })).toBe("ok");
    expect(arifpay.verifyWebhook({ rawBody: body + " ", headers: new Headers({ "x-arifpay-signature": sig }), url: url() })).toBe("bad");
  });
});

describe("arifpay refuses unsafe configurations", () => {
  const req = {
    token: "t",
    transactionId: "11111111-2222-3333-4444-555555555555",
    amount: 10,
    currency: "ETB",
    method: "wallet" as const,
    institution: "Telebirr",
    merchantName: "M",
    nonce: "n",
    expiresAt: new Date(Date.now() + 6e5),
    payerPhone: "+251911223344",
    urls: { success: "https://a", cancel: "https://b", error: "https://c", notify: "https://d" },
  };
  it("needs an API key outside the sandbox", async () => {
    process.env.ARIFPAY_SESSION_PATH = "/api/prod/c2b/session";
    await expect(arifpay.createPayment(req)).rejects.toThrow(/API_KEY/);
  });
  it("needs a webhook secret outside the sandbox", async () => {
    process.env.ARIFPAY_SESSION_PATH = "/api/prod/c2b/session";
    process.env.ARIFPAY_API_KEY = "k";
    await expect(arifpay.createPayment(req)).rejects.toThrow(/WEBHOOK_SECRET/);
  });
  it("never guesses a bank code for a beneficiary split", async () => {
    process.env.ARIFPAY_SESSION_PATH = "/api/prod/c2b/session";
    process.env.ARIFPAY_API_KEY = "k";
    process.env.ARIFPAY_WEBHOOK_SECRET = "x".repeat(32);
    process.env.ARIFPAY_USE_BENEFICIARIES = "true";
    process.env.ARIFPAY_DEFAULT_EMAIL = "ops@example.com";
    await expect(arifpay.createPayment({ ...req, method: "bank", beneficiary: { institution: "Awash Bank", accountNumber: "1000" } })).rejects.toThrow(/bank code/i);
  });
});

describe("smart routing", () => {
  const healthy = { ...EMPTY_HEALTH };
  it("parses config and ignores junk", () => {
    expect(parseRouting('{"default":["a","b"],"Telebirr":["t","a"]}')).toEqual({ default: ["a", "b"], Telebirr: ["t", "a"] });
    expect(parseRouting("not json")).toEqual({});
    expect(parseRouting("[1,2]")).toEqual({});
    expect(parseRouting(undefined)).toEqual({});
  });
  it("picks providers per institution, restricted to registered ones, without duplicates", () => {
    const cfg = parseRouting('{"default":["a"],"Telebirr":["t","a","a","ghost"]}');
    expect(candidatesFor("Telebirr", cfg, ["a", "t"], "a")).toEqual(["t", "a"]);
    expect(candidatesFor("Awash Bank", cfg, ["a", "t"], "a")).toEqual(["a"]);
    expect(candidatesFor("X", {}, ["arifpay"], "arifpay")).toEqual(["arifpay"]);
    expect(candidatesFor("X", {}, ["a"], "missing")).toEqual([]);
  });
  it("only calls a provider unhealthy on clear evidence", () => {
    expect(isUnhealthy({ ...healthy, recentAttempts: 4, recentFailures: 4 })).toBe(false); // too few attempts
    expect(isUnhealthy({ ...healthy, recentAttempts: 6, recentFailures: 3 })).toBe(true);
    expect(isUnhealthy({ ...healthy, recentAttempts: 6, recentFailures: 2 })).toBe(false);
    expect(isUnhealthy({ ...healthy, settled: 5, failed: 5 })).toBe(false); // 10 outcomes, 50% failed
    expect(isUnhealthy({ ...healthy, settled: 4, failed: 6 })).toBe(true); // 60% failed is the threshold
    expect(isUnhealthy({ ...healthy, settled: 3, failed: 7 })).toBe(true);
    expect(isUnhealthy({ ...healthy, settled: 1, failed: 5 })).toBe(false); // too few outcomes
  });
  it("keeps the operator's order but moves a failing provider to the back (still a last resort)", () => {
    const bad = { ...healthy, recentAttempts: 10, recentFailures: 9 };
    expect(rankProviders(["a", "b", "c"], { a: bad })).toEqual(["b", "c", "a"]);
    expect(rankProviders(["a", "b"], {})).toEqual(["a", "b"]);
    expect(rankProviders(["a", "b"], { a: bad, b: bad })).toEqual(["a", "b"]);
    expect(rankProviders(["a"], { a: bad })).toEqual(["a"]);
  });
});
