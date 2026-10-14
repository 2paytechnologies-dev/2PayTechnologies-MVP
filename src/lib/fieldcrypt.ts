import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { SavedAccount } from "@/lib/settlement";

/**
 * Application-level encryption of the most sensitive stored identifiers: bank account numbers, wallet numbers, tax ids
 * (TIN) and national-ID details. This sits ON TOP of the database's own disk encryption: even someone who can read the
 * database (a leaked backup, a stolen service key, a curious operator) sees only ciphertext without the key, which is held
 * in the server's environment and never in the database.
 *
 *   AES-256-GCM (authenticated: any change to the data is detected), a fresh random 96-bit nonce per value, and a separate
 *   key per kind of field derived with HKDF-SHA256, so a value copied from one column cannot be replayed into another.
 *   Stored as   enc:v1:<key id>:<nonce>:<tag>:<ciphertext>   (base64url).
 *
 * Switching it on: set DATA_ENCRYPTION_KEY (32 random bytes, base64: `openssl rand -base64 32`). New and updated values are
 * then encrypted; values written before stay readable (plain text is passed through) until `npm run encrypt-existing`
 * (or the admin job) re-saves them. Rotation: put the new key in DATA_ENCRYPTION_KEY and the old one in
 * DATA_ENCRYPTION_KEY_PREV; both decrypt, only the new one encrypts. Without a key nothing is encrypted and health says so.
 */
const PREFIX = "enc:v1:";

export type FieldContext = "account" | "tin" | "national-id";

const keyBytes = (raw: string | undefined): Buffer | null => {
  if (!raw) return null;
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
};
const current = () => keyBytes(process.env.DATA_ENCRYPTION_KEY);
const previous = () => keyBytes(process.env.DATA_ENCRYPTION_KEY_PREV);
const kid = (k: Buffer) => createHash("sha256").update(k).digest("hex").slice(0, 8);
const derive = (k: Buffer, ctx: FieldContext) => Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), `2pay:field:${ctx}`, 32));

export const encryptionActive = () => !!current();
export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);

/** Encrypt a value for storage. With no key configured the value is returned unchanged. */
export function sealField(plain: string, ctx: FieldContext): string {
  const k = current();
  if (!k || isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(k, ctx), iv);
  c.setAAD(Buffer.from(ctx));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${kid(k)}:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

/** Decrypt a stored value. Plain text (written before encryption was on) is returned as it is. Throws on tampering or a missing key. */
export function openField(stored: string, ctx: FieldContext): string {
  if (!isSealed(stored)) return stored;
  const [, , id, iv, tag, ct] = stored.split(":");
  const k = [current(), previous()].find((x) => x && kid(x) === id);
  if (!k || !iv || !tag || !ct) throw new Error("This value is encrypted with a key that is not configured");
  const d = createDecipheriv("aes-256-gcm", derive(k, ctx), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(ctx));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** Like openField but never throws: for places that only display (the caller shows a masked/placeholder value). */
export function tryOpenField(stored: string | null | undefined, ctx: FieldContext): string | null {
  if (stored == null) return null;
  try {
    return openField(stored, ctx);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ saved accounts (the JSON stored on `merchants`)
export type StoredAccount = SavedAccount & { last4?: string };

/** Encrypt the account number inside each account. The last four digits stay readable for masking and the change history. */
export const sealAccount = (a: SavedAccount): StoredAccount => ({ ...a, account_number: sealField(a.account_number, "account"), last4: a.account_number.slice(-4) });
export const sealAccounts = (list: SavedAccount[]): StoredAccount[] => list.map(sealAccount);

/** Decrypt for server-side use. An account whose number cannot be decrypted is dropped from use rather than guessed at. */
export function openAccount(a: StoredAccount | null | undefined): SavedAccount | null {
  if (!a) return null;
  const n = tryOpenField(a.account_number, "account");
  return n == null ? null : { id: a.id, institution: a.institution, account_number: n };
}
export const openAccounts = (list: StoredAccount[] | null | undefined): SavedAccount[] => (list ?? []).map(openAccount).filter((a): a is SavedAccount => !!a);