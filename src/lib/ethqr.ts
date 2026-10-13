import { buildEmvQr, type EmvAccountTemplate } from "@/lib/emvqr";

/**
 * Dynamic ETHQR assembly for one payment: an EMVCo merchant-presented QR carrying the merchant account the customer
 * should pay, the exact amount and our reference.
 *
 * What is NOT built in: the national scheme's merchant-account template (which tag, its GUID and sub-fields). EthSwitch /
 * the National Bank define it; it is supplied as ETHQR_TEMPLATE and never guessed. Until it is set, no payload is built
 * and everything falls back to the web checkout.
 *
 *   ETHQR_TEMPLATE={"tag":26,"guid":"<scheme guid>","fields":{"01":"{account}","02":"{institution}"}}
 *
 * Placeholders: {account} the receiving account number, {institution}, {merchant}, {ref}.
 */
export interface EthQrTemplate {
  tag: number;
  guid: string;
  fields?: Record<string, string>;
}

export function parseTemplate(raw: string | undefined): EthQrTemplate | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<EthQrTemplate>;
    if (typeof t.tag !== "number" || typeof t.guid !== "string" || !t.guid) return null;
    if (t.tag < 26 || t.tag > 51) return null;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.fields ?? {})) {
      if (/^\d{2}$/.test(k) && k !== "00" && typeof v === "string") fields[k] = v;
    }
    return { tag: t.tag, guid: t.guid, fields };
  } catch {
    return null;
  }
}

const MCC: Record<string, string> = { Fuel: "5541", Retail: "5411" };

export interface EthQrInput {
  merchantName: string;
  category: string;
  city?: string | null;
  account: { institution: string; account_number: string };
  amount: number;
  reference: string;
}

/** The payload, or null when the scheme template is not configured or the data does not fit the format. */
export function buildEthQr(i: EthQrInput, rawTemplate: string | undefined = process.env.ETHQR_TEMPLATE): string | null {
  const t = parseTemplate(rawTemplate);
  if (!t) return null;
  const fill = (s: string) => s.replace(/\{(account|institution|merchant|ref)\}/g, (_, k: string) => ({ account: i.account.account_number, institution: i.account.institution, merchant: i.merchantName, ref: i.reference })[k] ?? "");
  const account: EmvAccountTemplate = { tag: t.tag, guid: t.guid, fields: Object.fromEntries(Object.entries(t.fields ?? {}).map(([k, v]) => [k, fill(v)])) };
  try {
    return buildEmvQr({ merchantName: i.merchantName, merchantCity: i.city || "Addis Ababa", mcc: MCC[i.category] ?? "5999", account, amount: i.amount, reference: i.reference });
  } catch {
    return null; // a field is too long for the format: fall back to the web checkout rather than send a broken QR
  }
}