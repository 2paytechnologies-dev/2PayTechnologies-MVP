export type Status = "PENDING" | "SUCCESS" | "FAILED";
export type Rail = "EthioPay-IPS" | "Telebirr" | "CBE Birr";
export const RAILS: Rail[] = ["EthioPay-IPS", "Telebirr", "CBE Birr"];

export interface Merchant {
  id: string;
  business_name: string;
  category: "Fuel" | "Retail";
  terminal_id: string;
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

/** 2Pay algorithmic orchestration fee: 0.5% of amount, min 0.25 ETB. */
export function computeFee(amount: number): number {
  return Math.max(0.25, Math.round(amount * 0.005 * 100) / 100);
}
