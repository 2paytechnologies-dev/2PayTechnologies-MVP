import type { SupabaseClient } from "@supabase/supabase-js";
import { fmt, referenceFor } from "@/lib/format";
import { sendSms, smsConfigured } from "@/lib/sms";

/** The receipt SMS text. Pure, so it is unit tested. Amharic for payers who used the Amharic screens. */
export function receiptText(lang: string, p: { amount: number; currency: string; merchant: string; reference: string; tip?: number }): string {
  const tip = p.tip && p.tip > 0 ? p.tip : 0;
  const amount = fmt(p.amount + tip); // what the customer paid in all
  const cur = p.currency === "ETB" ? "ብር" : p.currency;
  return lang === "am"
    ? `2Pay ደረሰኝ፦ ${amount} ${cur} ለ${p.merchant} ተከፍሏል${tip ? ` (${fmt(tip)} ${cur} ጉርሻን ጨምሮ)` : ""}። ማጣቀሻ ${p.reference}። እናመሰግናለን።`
    : `2Pay receipt: ${amount} ${p.currency} paid to ${p.merchant}${tip ? ` (includes ${fmt(tip)} tip)` : ""}. Ref ${p.reference}. Thank you.`;
}

/** Remember where to send this sale's receipt. Personal data: server-only table, never returned to a browser. */
export async function saveReceiptContact(admin: SupabaseClient, transactionId: string, phone: string, lang: string): Promise<void> {
  try {
    await admin.from("payer_contacts").upsert({ transaction_id: transactionId, phone, lang: lang === "am" ? "am" : "en" }, { onConflict: "transaction_id" });
  } catch (e) {
    console.error("[receipts] could not save contact:", (e as Error).message); // a missing receipt must never block a payment
  }
}

/**
 * Send the receipt SMS once for a paid sale. Idempotent (the first caller claims it), honours the merchant's
 * "SMS receipts" setting, and never throws: receipts are a courtesy, not part of the payment.
 */
export async function sendReceiptSms(admin: SupabaseClient, transactionId: string): Promise<void> {
  try {
    if (!smsConfigured()) return;
    const { data: claimed } = await admin
      .from("payer_contacts")
      .update({ receipt_sent: true })
      .eq("transaction_id", transactionId)
      .eq("receipt_sent", false)
      .select("phone, lang")
      .maybeSingle();
    if (!claimed) return; // no contact on file, or already sent

    const { data: tx } = await admin.from("transactions").select("id, amount, tip_amount, currency, merchants(business_name, sms_receipts)").eq("id", transactionId).maybeSingle();
    const m = (Array.isArray(tx?.merchants) ? tx?.merchants[0] : tx?.merchants) as { business_name: string; sms_receipts: boolean | null } | null | undefined;
    if (!tx || !m || m.sms_receipts === false) return;

    const ok = await sendSms(claimed.phone, receiptText(claimed.lang, { amount: Number(tx.amount), tip: Number(tx.tip_amount ?? 0), currency: tx.currency, merchant: m.business_name, reference: referenceFor(tx.id) }));
    if (!ok) await admin.from("payer_contacts").update({ receipt_sent: false }).eq("transaction_id", transactionId); // allow a retry
  } catch (e) {
    console.error("[receipts] failed:", (e as Error).message);
  }
}
