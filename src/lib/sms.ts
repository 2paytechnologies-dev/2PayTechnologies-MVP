/**
 * SMS delivery for one-time codes. There is no bundled provider: point SMS_WEBHOOK_URL at your SMS gateway
 * (or an automation that calls one) and it receives { "to": "+251…", "message": "…" } as JSON, with
 * "Authorization: Bearer $SMS_WEBHOOK_TOKEN" when a token is set. Any 2xx response counts as delivered.
 */
export const smsConfigured = () => !!process.env.SMS_WEBHOOK_URL;

export async function sendOtpSms(phone: string, code: string): Promise<boolean> {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to: phone, message: `Your 2Pay verification code is ${code}. It expires in 5 minutes.` }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (e) {
    console.error("[sms] delivery failed:", (e as Error).message);
    return false;
  }
}
