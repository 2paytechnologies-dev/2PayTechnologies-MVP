import type { SupabaseClient } from "@supabase/supabase-js";

export interface AccountRef {
  merchantId: string;
  role: "OWNER" | "CASHIER";
  businessName: string;
  terminalId: string;
}

/**
 * Who does this verified phone belong to? The merchant's own phone is the OWNER; an active staff phone is a CASHIER
 * of the merchant that added them. A phone is never both (staff creation refuses a phone that is already an account).
 */
export async function findAccountByPhone(admin: SupabaseClient, phone: string): Promise<AccountRef | null> {
  const { data: owner } = await admin.from("merchants").select("id, business_name, terminal_id").eq("phone", phone).maybeSingle();
  if (owner) return { merchantId: owner.id, role: "OWNER", businessName: owner.business_name, terminalId: owner.terminal_id };

  const { data: staff } = await admin
    .from("merchant_staff")
    .select("merchant_id, merchants(business_name, terminal_id)")
    .eq("phone", phone)
    .eq("active", true)
    .maybeSingle();
  if (!staff) return null;
  const m = (Array.isArray(staff.merchants) ? staff.merchants[0] : staff.merchants) as { business_name: string; terminal_id: string } | null;
  if (!m) return null;
  return { merchantId: staff.merchant_id, role: "CASHIER", businessName: m.business_name, terminalId: m.terminal_id };
}
