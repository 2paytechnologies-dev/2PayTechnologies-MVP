/**
 * SMS delivery. There is no bundled provider: point SMS_WEBHOOK_URL at your SMS gateway (or an automation that calls
 * one) and it receives { "to": "+251…", "message": "…" } as JSON, with "Authorization: Bearer $SMS_WEBHOOK_TOKEN" when a
 * token is set. Any 2xx response counts as delivered. Used for one-time codes and payer receipts.
 */
export const smsConfigured = () => !!process.env.SMS_WEBHOOK_URL;

export async function sendSms(phone: string, message: string): Promise<boolean> {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to: phone, message }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (e) {
    console.error("[sms] delivery failed:", (e as Error).message);
    return false;
  }
}

export const sendOtpSms = (phone: string, code: string) => sendSms(phone, `Your 2Pay verification code is ${code}. It expires in 5 minutes.`);
