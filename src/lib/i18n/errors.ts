import type { Key } from "./dict";

/**
 * The server returns plain English error messages. This maps the ones a payer or cashier is likely to see onto
 * translated strings, matched by their exact text; anything unknown is shown as is (still readable, just English).
 */
const KNOWN: Record<string, Key> = {
  "This pay node has expired. Ask the cashier for a new code.": "err.expired",
  "This pay node does not exist": "err.notFound",
  "This payment failed. Ask the cashier for a new code.": "err.failed",
  "Too many attempts. Please wait a moment and try again.": "err.tooMany",
  "That mobile number doesn't look right. Use the format 0911223344.": "err.badPhone",
  "Enter the mobile number of the account you are paying from, e.g. 0911223344": "err.needPhone",
  "The merchant does not accept that payment method": "err.noMethod",
  "The payment provider is unreachable right now. Please try again in a moment.": "err.providerDown",
  "The payment provider could not start this payment.": "err.providerFail",
  "Payments are not configured yet": "err.notConfigured",
  "The merchant changed their account. Ask the cashier for a new code.": "err.merchantChanged",
  "Token invalid, used or expired": "err.tokenInvalid",
  "Business verification is required before taking live payments.": "err.kycRequired",
  "No settlement account configured. Add and activate a bank or wallet first.": "err.noRouting",
};

export function localizeError(message: string, t: (key: Key) => string): string {
  const key = KNOWN[message];
  return key ? t(key) : message;
}
