/**
 * EMVCo Merchant-Presented QR (MPM) payload encoder, the format banks' and wallets' own apps scan.
 *
 * STATUS: groundwork. The generic EMVCo structure and CRC are implemented and tested. What makes a QR payable in a
 * given country's bank apps is the scheme's *merchant account template* (which tag 26-51, and its GUID/fields), which
 * Ethiopia's national scheme (EthSwitch / National Bank) defines. That value is supplied by configuration, not guessed
 * here; and a bank-app payment settles through that bank, so it needs its own settlement feed into 2Pay. Neither is
 * wired in V2.1. See docs/ROADMAP_V2_1.md.
 */

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): the checksum EMVCo QR requires. Returns 4 upper-case hex digits. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const tlv = (tag: string, value: string) => {
  if (value.length > 99) throw new Error(`EMV QR field ${tag} is longer than 99 characters`);
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
};

export interface EmvAccountTemplate {
  /** Template tag, 26 to 51. Set by the scheme. */
  tag: number;
  /** Globally unique identifier of the scheme (sub-tag 00). */
  guid: string;
  /** Further sub-tags, keyed by two-digit id. */
  fields?: Record<string, string>;
}

export interface EmvQrInput {
  merchantName: string; // max 25
  merchantCity: string; // max 15
  /** ISO 18245 merchant category code, 4 digits (5541 fuel stations, 5411 grocery, ...). */
  mcc: string;
  account: EmvAccountTemplate;
  /** Fixed amount makes a dynamic QR ("12"); omit it for a static QR ("11") where the payer types the amount. */
  amount?: number;
  /** Reference label shown to the payer / returned to the merchant (max 25). */
  reference?: string;
  countryCode?: string; // default ET
  currencyNumeric?: string; // default 230 = ETB
}

export function buildEmvQr(i: EmvQrInput): string {
  if (!/^\d{4}$/.test(i.mcc)) throw new Error("mcc must be 4 digits");
  if (i.account.tag < 26 || i.account.tag > 51) throw new Error("account template tag must be 26-51");
  const dynamic = i.amount !== undefined;
  const sub = tlv("00", i.account.guid) + Object.entries(i.account.fields ?? {}).map(([k, v]) => tlv(k, v)).join("");
  const body =
    tlv("00", "01") +
    tlv("01", dynamic ? "12" : "11") +
    tlv(String(i.account.tag).padStart(2, "0"), sub) +
    tlv("52", i.mcc) +
    tlv("53", i.currencyNumeric ?? "230") +
    (dynamic ? tlv("54", i.amount!.toFixed(2)) : "") +
    tlv("58", i.countryCode ?? "ET") +
    tlv("59", i.merchantName.slice(0, 25)) +
    tlv("60", i.merchantCity.slice(0, 15)) +
    (i.reference ? tlv("62", tlv("05", i.reference.slice(0, 25))) : "");
  const withCrcHeader = `${body}6304`;
  return withCrcHeader + crc16(withCrcHeader);
}

/** Read a payload back into top-level tags, verifying the CRC. Throws on a malformed or corrupted payload. */
export function parseEmvQr(payload: string): Record<string, string> {
  const crcAt = payload.length - 4;
  if (payload.slice(crcAt - 4, crcAt) !== "6304") throw new Error("missing CRC field");
  if (crc16(payload.slice(0, crcAt)) !== payload.slice(crcAt).toUpperCase()) throw new Error("CRC mismatch");
  const out: Record<string, string> = {};
  for (let pos = 0; pos < payload.length; ) {
    const tag = payload.slice(pos, pos + 2);
    const len = Number(payload.slice(pos + 2, pos + 4));
    if (!Number.isInteger(len) || pos + 4 + len > payload.length) throw new Error("bad TLV length");
    out[tag] = payload.slice(pos + 4, pos + 4 + len);
    pos += 4 + len;
  }
  return out;
}
