import { createHmac, timingSafeEqual } from "node:crypto";
import type { SavedAccount } from "@/lib/settlement";

/**
 * The settlement vault's rules (pure, unit tested). Where customer money lands is the most sensitive setting in 2Pay, so
 * changing it needs more than a signed-in session: a fresh one-time code sent only to the owner's registered phone.
 */

export interface Snapshot {
  saved_banks: SavedAccount[] | null;
  saved_wallets: SavedAccount[] | null;
  active_bank: SavedAccount | null;
  active_wallet: SavedAccount | null;
}

export type ChangeKind =
  /** Nothing that moves money changed (or only an unused extra account was added). */
  | "NONE"
  /** The very first receiving account(s): nothing exists yet that could be diverted, so no code is asked for. */
  | "SETUP"
  /** An account was removed or edited, or the account money goes to was switched: needs the owner's code. */
  | "SENSITIVE";

const byId = (list: SavedAccount[] | null) => new Map((list ?? []).map((a) => [a.id, a]));

export function classifyChange(prev: Snapshot, next: Snapshot): ChangeKind {
  const before = [...byId(prev.saved_banks), ...byId(prev.saved_wallets)];
  const after = new Map([...byId(next.saved_banks), ...byId(next.saved_wallets)]);
  const prevMap = new Map(before);

  const removed = before.some(([id]) => !after.has(id));
  const edited = before.some(([id, a]) => {
    const n = after.get(id);
    return !!n && (n.institution !== a.institution || n.account_number !== a.account_number);
  });
  const added = [...after.keys()].some((id) => !prevMap.has(id));
  const activeChanged = (prev.active_bank?.id ?? null) !== (next.active_bank?.id ?? null) || (prev.active_wallet?.id ?? null) !== (next.active_wallet?.id ?? null);
  const hadActive = !!prev.active_bank || !!prev.active_wallet;

  if (!removed && !edited && !added && !activeChanged) return "NONE";
  if (!hadActive && !removed && !edited) return "SETUP";
  if (removed || edited || activeChanged) return "SENSITIVE";
  return "NONE"; // only an extra, inactive account was added: it cannot receive money until it is activated (which needs the code)
}

// ------------------------------------------------------------------ the step-up pass
/** After the owner enters the code, the browser holds this signed pass for a few minutes. */
export const STEP_UP_COOKIE = "2pay_stepup";
export const STEP_UP_TTL_S = 300;

interface Pass {
  k: "stepup";
  mid: string;
  ph: string;
  exp: number;
}

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(`2pay:stepup:${body}`).digest("base64url");

export function signStepUp(mid: string, ph: string, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ k: "stepup", mid, ph, exp: Math.floor(now / 1000) + STEP_UP_TTL_S } satisfies Pass)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** True only for an unexpired pass signed by us, for THIS merchant and THIS phone. */
export function verifyStepUp(token: string | undefined, mid: string, ph: string, secret: string | undefined, now = Date.now()): boolean {
  if (!token || !secret) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Pass;
    return p.k === "stepup" && p.mid === mid && p.ph === ph && p.exp * 1000 > now;
  } catch {
    return false;
  }
}