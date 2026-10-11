/**
 * The contract every payment rail implements. 2Pay orchestrates; an adapter is the only code that knows how one
 * provider (Arifpay, Telebirr, a bank API, ...) starts a payment and reports its result. Adding a rail means
 * writing one adapter and registering it in ./index.ts. Nothing else in the app changes.
 */
export type RailMethod = "bank" | "wallet";

export interface PaymentRequest {
  /** Our pay-node token (single use). */
  token: string;
  transactionId: string;
  amount: number;
  currency: string;
  method: RailMethod;
  /** The institution the payer chose, e.g. "Awash Bank" or "Telebirr". */
  institution: string;
  merchantName: string;
  /** The merchant's active account for this method, when the provider can split funds straight to it. */
  beneficiary?: { institution: string; accountNumber: string };
  /** Unique correlation id we generate; the provider echoes it back in its webhook. */
  nonce: string;
  expiresAt: Date;
  payerPhone: string;
  urls: { success: string; cancel: string; error: string; notify: string };
}

export interface PaymentSession {
  sessionId: string;
  /** Where to send the payer to approve the payment (provider-hosted checkout or deep link). */
  checkoutUrl: string;
}

export type RailStatus = "SETTLED" | "FAILED" | "PENDING";

/** A provider callback, normalised. */
export interface RailEvent {
  nonce?: string;
  sessionId?: string;
  status: RailStatus;
  /** Amount the provider says it collected. */
  amount?: number;
  providerRef?: string;
  /** The method the payer actually used, as the provider names it. */
  paymentMethod?: string;
}

export interface WebhookInput {
  rawBody: string;
  headers: Headers;
  url: URL;
}

export type WebhookAuth = "ok" | "bad" | "unconfigured";

export interface RailAdapter {
  id: string;
  label: string;
  /** Start a payment. Throws RailError on failure. */
  createPayment(req: PaymentRequest): Promise<PaymentSession>;
  /** The notify URL to register with each session, including any authenticity token the provider will echo back. */
  notifyUrl(baseUrl: string): string;
  /** Is this webhook really from the provider? */
  verifyWebhook(input: WebhookInput): WebhookAuth;
  /** Map the provider's payload to a RailEvent, or null if it carries no payment outcome. */
  parseWebhook(body: unknown): RailEvent | null;
}

export class RailError extends Error {
  constructor(
    message: string,
    /** True when retrying the same request may succeed (network or 5xx). */
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RailError";
  }
}
