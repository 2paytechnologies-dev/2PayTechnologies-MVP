// One-time job: encrypts the account numbers and TINs that were saved BEFORE DATA_ENCRYPTION_KEY was set.
//
//   Dry run (changes nothing, says what it would do):
//     $env:NEXT_PUBLIC_SUPABASE_URL="https://<project>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="<service role key>"
//     $env:DATA_ENCRYPTION_KEY="<the SAME key that is set in Vercel>"
//     npm run encrypt-existing
//   Then add --apply to write:   npm run encrypt-existing -- --apply
//
// Safe to re-run: values that are already encrypted are skipped. It also re-seals rows written with DATA_ENCRYPTION_KEY_PREV
// when that variable is set (key rotation). Nothing is ever printed except counts.
import { encryptionActive, isSealed, openField, sealAccount, sealField } from "../src/lib/fieldcrypt.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes("--apply");
if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
if (!encryptionActive()) throw new Error("Set DATA_ENCRYPTION_KEY (the same value as in Vercel) first. Nothing was changed.");

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const rest = async (path, init) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path.split("?")[0]} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};

/** Plain or old-key value -> sealed with the current key. Returns the same value if it is already current. */
const reseal = (stored, ctx) => {
  if (typeof stored !== "string" || !stored) return stored;
  const plain = openField(stored, ctx); // throws if it cannot be opened, so nothing is overwritten with garbage
  const next = sealField(plain, ctx);
  return isSealed(stored) && openField(next, ctx) === plain && stored.split(":")[2] === next.split(":")[2] ? stored : next;
};
const resealAccount = (a) => {
  if (!a || typeof a !== "object") return a;
  const plain = openField(String(a.account_number), "account");
  const sealed = sealAccount({ id: a.id, institution: a.institution, account_number: plain });
  const same = isSealed(a.account_number) && a.account_number.split(":")[2] === sealed.account_number.split(":")[2] && a.last4 === sealed.last4;
  return same ? a : { ...a, ...sealed };
};

const rows = await rest("merchants?select=id,saved_banks,saved_wallets,active_bank,active_wallet,tin&order=id");
let touched = 0;
let skipped = 0;
for (const m of rows) {
  const patch = {};
  const lists = ["saved_banks", "saved_wallets"];
  for (const col of lists) {
    if (!Array.isArray(m[col])) continue;
    const next = m[col].map(resealAccount);
    if (JSON.stringify(next) !== JSON.stringify(m[col])) patch[col] = next;
  }
  for (const col of ["active_bank", "active_wallet"]) {
    if (!m[col]) continue;
    const next = resealAccount(m[col]);
    if (JSON.stringify(next) !== JSON.stringify(m[col])) patch[col] = next;
  }
  if (m.tin) {
    const next = reseal(m.tin, "tin");
    if (next !== m.tin) patch.tin = next;
  }
  if (!Object.keys(patch).length) { skipped++; continue; }
  touched++;
  if (apply) await rest(`merchants?id=eq.${encodeURIComponent(m.id)}`, { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } });
}
console.log(`${rows.length} businesses checked: ${touched} ${apply ? "encrypted" : "would be encrypted (dry run, nothing changed)"}, ${skipped} already up to date.`);
if (!apply && touched) console.log("Run again with  npm run encrypt-existing -- --apply  to write the changes.");
