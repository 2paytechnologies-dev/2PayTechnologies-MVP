import type { SupabaseClient } from "@supabase/supabase-js";

/** What the running code needs from the database, and the migration that creates it. */
const COLUMNS: { table: string; columns: string; migration: string }[] = [
  { table: "merchants", columns: "id, active_bank, active_wallet", migration: "multi_rail_routing.sql" },
  { table: "merchants", columns: "kyc_status, legal_name, tin, static_qr_enabled, sms_receipts, terms_accepted_at", migration: "v2_1.sql" },
  { table: "transactions", columns: "id, expected_amount, fee_ft, routed_bank, routed_wallet", migration: "multi_rail_routing.sql" },
  { table: "transactions", columns: "rail_provider, rail_nonce", migration: "rails_live.sql" },
  { table: "transactions", columns: "source", migration: "v2_1.sql" },
  { table: "merchant_staff", columns: "id, role, team_no, invite_token_hash, invite_expires_at, activated_at, device_id_hash", migration: "v2_2.sql" },
  { table: "transactions", columns: "staff_id, tip_amount", migration: "v2_2.sql" },
  { table: "transactions", columns: "payer_app", migration: "v2_3.sql" },
  { table: "merchants", columns: "vault_pin_hash, vault_failed, vault_locked_until, fayda_verified_at, fayda_subject_hash, fayda_name", migration: "v2_4.sql" },
  { table: "merchant_staff", columns: "vault_pin_hash, vault_failed, vault_locked_until, fayda_verified_at", migration: "v2_4.sql" },
  { table: "transactions", columns: "base_fee, vat_fee, net_merchant_settlement, payee_accounts, ride_session_id", migration: "v2_5.sql" },
  { table: "merchants", columns: "fayda_fan, fayda_verified, fayda_verification_timestamp, fayda_transaction_id", migration: "v2_5.sql" },
  { table: "merchants", columns: "kind", migration: "v2_6.sql" },
  { table: "ride_partners", columns: "allow_partner_accounts", migration: "v2_7.sql" },
  { table: "ride_sessions", columns: "driver_merchant_id", migration: "v2_7.sql" },
  { table: "ride_partners", columns: "contact_name, contact_phone", migration: "v2_6.sql" },
];
const TABLES: { table: string; migration: string }[] = [
  { table: "rail_events", migration: "rails_live.sql" },
  ...["payer_contacts", "merchant_staff", "refund_requests", "audit_log", "app_errors", "rail_attempts"].map((table) => ({ table, migration: "v2_1.sql" })),
  { table: "settlement_change_log", migration: "v2_3.sql" },
  ...["ride_partners", "ride_sessions", "fayda_sessions"].map((table) => ({ table, migration: "v2_5.sql" })),
  ...["ai_event_outbox", "ai_scores"].map((table) => ({ table, migration: "v2_6.sql" })),
  ...["ride_driver_links", "ride_link_codes", "tax_settings"].map((table) => ({ table, migration: "v2_7.sql" })),
];

export interface SchemaStatus {
  ok: boolean;
  /** Migration files that still need to be run, in the order to run them. */
  missing: string[];
}

const ORDER = ["pilot_reconcile.sql", "multi_rail_routing.sql", "merchant_registration.sql", "rails_live.sql", "v2_1.sql", "v2_2.sql", "v2_3.sql", "v2_4.sql", "v2_5.sql", "v2_6.sql", "v2_7.sql"];

/** Asks the database whether every column and table this release uses exists. Names files only, never data. */
export async function checkSchema(admin: SupabaseClient): Promise<SchemaStatus> {
  const missing = new Set<string>();
  await Promise.all([
    ...COLUMNS.map(async (c) => {
      const { error } = await admin.from(c.table).select(c.columns).limit(1);
      if (error) missing.add(c.migration);
    }),
    ...TABLES.map(async (t) => {
      const { error } = await admin.from(t.table).select("*").limit(1);
      if (error) missing.add(t.migration);
    }),
  ]);
  return { ok: missing.size === 0, missing: ORDER.filter((f) => missing.has(f)) };
}
