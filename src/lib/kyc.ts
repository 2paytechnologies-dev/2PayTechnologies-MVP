/** Business verification (KYC) fields and their validation. Pure, so the API and the form share it. */
export interface BusinessProfile {
  legal_name: string;
  tin: string;
  business_license: string;
  address: string;
  location: string;
}

export type KycStatus = "UNVERIFIED" | "SUBMITTED" | "VERIFIED" | "REJECTED";

/** Ethiopian TIN: 10 digits (spaces and dashes tolerated). */
export function normalizeTin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(s) ? s : null;
}

export type ProfileResult = { ok: true; profile: BusinessProfile } | { ok: false; error: string };

export function validateProfile(input: unknown): ProfileResult {
  const b = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown, min: number, max: number) => (typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
  const legal = text(b.legal_name, 2, 120);
  const license = text(b.business_license, 3, 60);
  const address = text(b.address, 5, 200);
  const tin = normalizeTin(b.tin);
  const location = typeof b.location === "string" ? b.location.trim().slice(0, 200) : "";
  if (!legal) return { ok: false, error: "Enter the registered business name (2–120 characters)" };
  if (!tin) return { ok: false, error: "The TIN must be 10 digits" };
  if (!license) return { ok: false, error: "Enter the business licence number (3–60 characters)" };
  if (!address) return { ok: false, error: "Enter the business address (5–200 characters)" };
  return { ok: true, profile: { legal_name: legal, tin, business_license: license, address, location } };
}

export const maskTin = (tin: string | null) => (tin ? `••••••${tin.slice(-4)}` : "");
