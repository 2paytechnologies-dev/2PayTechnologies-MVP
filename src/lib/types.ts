/** PENDING -> SUCCESS (customer authorized) -> SETTLED (Arifpay confirmed via webhook). */
export type Status = "PENDING" | "SUCCESS" | "SETTLED" | "FAILED";
export type Rail = "EthioPay-IPS" | "Telebirr" | "CBE Birr";
export const RAILS: Rail[] = ["EthioPay-IPS", "Telebirr", "CBE Birr"];

/** Statuses where the customer has authorized and funds are moving or moved. */
export const PAID_STATUSES: Status[] = ["SUCCESS", "SETTLED"];
export const isPaid = (s: Status) => s === "SUCCESS" || s === "SETTLED";

/** Cost of one ad impression, deducted from the campaign's remaining_budget. */
export const AD_IMPRESSION_COST = 0.05;

export interface Merchant {
  id: string;
  business_name: string;
  category: "Fuel" | "Retail";
  terminal_id: string;
  location: string | null;
}

export interface Transaction {
  id: string;
  merchant_id: string;
  token: string;
  amount: number;
  currency: string;
  status: Status;
  rail: Rail;
  fee_ft: number;
  latency_ms: number | null;
  viewed_at: string | null;
  expires_at: string;
  created_at: string;
  expected_amount: number | null;
  settled_amount: number | null;
  settled_at: string | null;
  arifpay_ref: string | null;
}

/** Shape returned by the open_transaction() RPC. */
export interface PayView {
  token: string;
  amount: number;
  currency: string;
  status: Status;
  rail: Rail;
  expires_at: string;
  merchant_name: string;
  merchant_category: string;
  terminal_id: string;
}

export type CampaignStatus = "ACTIVE" | "PAUSED" | "EXHAUSTED";
export type TargetCategory = "ALL" | "Fuel" | "Retail";

export interface AdCampaign {
  id: string;
  merchant_id: string | null;
  title: string;
  description: string;
  target_category: TargetCategory;
  image_url: string | null;
  phone_cta: string | null;
  location_cta: string | null;
  budget: number;
  remaining_budget: number;
  impressions_count: number;
  clicks_count: number;
  status: CampaignStatus;
  created_at: string;
}

/** Ad as exposed to the payer's receipt screen (no budget internals). */
export type ServedAd = Pick<AdCampaign, "id" | "title" | "description" | "image_url" | "phone_cta" | "location_cta">;

export type WatchdogEventType =
  | "VELOCITY_SPIKE"
  | "ECR_MISMATCH"
  | "FUEL_TELEMETRY"
  | "AML_FIS_SAR"
  | "SETTLEMENT_MISMATCH";
export type WatchdogSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export interface WatchdogEvent {
  id: string;
  event_type: WatchdogEventType;
  severity: WatchdogSeverity;
  risk_score: number;
  merchant_id: string | null;
  transaction_id: string | null;
  message: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface ReceiptView {
  reference: string;
  amount: number;
  currency: string;
  status: Status;
  rail: Rail;
  merchant_name: string;
  terminal_id: string;
  location: string | null;
  paid_at: string;
  transaction_id: string;
  ad: ServedAd | null;
}
