import { createHmac, randomUUID } from "node:crypto";
import { claimText } from "@/lib/fayda";

/**
 * Owner e-KYC with the Fayda national ID by FAN (the 16-digit Fayda Alias Number) and a one-time code sent to the owner's
 * Fayda-linked phone. Two steps: ask the gateway to send the code, then check the code.
 *
 * Two gateways behind one interface:
 *  - "sandbox" (FAYDA_SANDBOX_MODE=true): for development. Any 16-digit FAN, and the code is always 123456. It is REFUSED when
 *    RAIL_MODE=live, so real money can never be unlocked with a code anyone can guess.
 *  - "gateway" (FAYDA_EKYC_URL + FAYDA_EKYC_KEY): the real Fayda e-KYC / authentication service. Its access is granted by the
 *    National ID Program to an onboarded organisation, and the exact request format is theirs: the JSON shape below is what
 *    this adapter assumes and is the one place to adjust when you receive their specification.
 *
 * The FAN is sensitive: it is never logged, never returned to a browser, and kept (encrypted) only as long as the code is pending
 * and, after success, encrypted on the merchant's record. The national ID number itself is not kept.
 */

export const FAN_RE = /^\d{16}$/;
/** Spaces and dashes are tolerated when typing; the FAN itself is exactly 16 digits. */
export function normalizeFan(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s-]/g, "");
  return FAN_RE.test(s) ? s : null;
}

export const SANDBOX_OTP = "123456";
export const EKYC_TTL_S = 600;
export const EKYC_MAX_ATTEMPTS = 5;

type Env = Record<string, string | undefined>;

/** Which gateway is active. Sandbox never applies to live money. */
export function ekycMode(env: Env = process.env, live = env.RAIL_MODE === "live"): "sandbox" | "gateway" | null {
  if (env.FAYDA_SANDBOX_MODE === "true" && !live) return "sandbox";
  if (env.FAYDA_EKYC_URL && env.FAYDA_EKYC_KEY) return "gateway";
  return null;
}

/**
 * With real money, the owner's Fayda verification is mandatory (the national payments rules anchor on Fayda), unless the operator
 * explicitly sets KYC_REQUIRE_FAYDA=false, for example while the Fayda connection is still being arranged.
 */
export const faydaRequired = (env: Env = process.env, live = env.RAIL_MODE === "live") => live && env.KYC_REQUIRE_FAYDA !== "false";

/** A keyed hash of the FAN, so the same person can be recognised across businesses without keeping the number. */
export const fanHash = (fan: string, secret: string) => createHmac("sha256", secret).update(`2pay:fayda:fan:${fan}`).digest("hex");

export class EkycError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export type Initiated = { ref: string; phoneHint: string | null };
export type Verified = { ok: true; name: string | null; ref: string } | { ok: false; reason: string };

export interface EkycGateway {
  initiate(fan: string): Promise<Initiated>;
  verify(fan: string, ref: string, otp: string): Promise<Verified>;
}

const sandbox: EkycGateway = {
  async initiate() {
    return { ref: `sandbox-${randomUUID()}`, phoneHint: "09••••••00" };
  },
  async verify(_fan, ref, otp) {
    return otp === SANDBOX_OTP ? { ok: true, name: "Sandbox Owner", ref } : { ok: false, reason: "Incorrect code." };
  },
};

function http(env: Env): EkycGateway {
  const base = (env.FAYDA_EKYC_URL as string).replace(/\/+$/, "");
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.FAYDA_EKYC_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      throw new EkycError("The national ID service is not reachable right now. Please try again in a moment.", 502);
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { res, data };
  };
  return {
    async initiate(fan) {
      const ref = randomUUID();
      const { res, data } = await post("/otp", { individualId: fan, individualIdType: "FAN", transactionID: ref });
      if (res.status === 404 || res.status === 422) throw new EkycError("That Fayda number was not found. Check the 16 digits and try again.", 404);
      if (!res.ok) throw new EkycError("The national ID service could not send a code. Please try again later.", 502);
      return { ref: typeof data?.transactionID === "string" ? data.transactionID : ref, phoneHint: typeof data?.maskedPhone === "string" ? data.maskedPhone.slice(0, 20) : null };
    },
    async verify(fan, ref, otp) {
      const { res, data } = await post("/verify", { individualId: fan, individualIdType: "FAN", transactionID: ref, otp });
      if (res.status >= 500 || res.status === 429) throw new EkycError("The national ID service could not check the code. Please try again.", 502);
      if (!res.ok || data?.authStatus !== true) return { ok: false, reason: "Incorrect code." };
      return { ok: true, name: claimText(data.name) ?? claimText(data.fullName), ref: typeof data.transactionID === "string" ? data.transactionID : ref };
    },
  };
}

export function ekycGateway(env: Env = process.env, live?: boolean): EkycGateway | null {
  const mode = ekycMode(env, live);
  return mode === "sandbox" ? sandbox : mode === "gateway" ? http(env) : null;
}
