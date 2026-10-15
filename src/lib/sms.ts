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

/** The code that unlocks changing where a business receives money. The wording says what it is for, so it is not given away. */
export const sendStepUpSms = (phone: string, code: string) =>
  sendSms(phone, `2Pay code ${code}: to confirm changing where your business receives money. Do not share it. If you did not ask for this, ignore this message. Expires in 5 minutes.\n2Pay ኮድ ${code}፦ ገንዘብ የሚቀበሉበትን ሂሳብ ለመቀየር። ለማንም አይስጡ። ያልጠየቁ ከሆነ ይህን መልእክት ችላ ይበሉ።`);

/** Told to the person (and the owner) when a security key is changed with the forgotten-key check, so a change they did not make is noticed at once. */
export const sendKeyChangedSms = (phone: string, business: string, who: string) =>
  sendSms(phone, `2Pay: the security key for ${who} at ${business} was just changed. If this was not you, contact 2Pay support now.\n2Pay፦ የ${business} ${who} ደህንነት ቁልፍ አሁን ተቀይሯል። እርስዎ ካልሆኑ አሁኑኑ 2Pay ድጋፍን ያነጋግሩ።`);

/** Told to the owner after any change to the receiving accounts, so a change they did not make is noticed at once. */
export const sendSettlementChangedSms = (phone: string, business: string) =>
  sendSms(phone, `2Pay: the account where ${business} receives money was just changed. If this was not you, contact 2Pay support now.\n2Pay፦ ${business} ገንዘብ የሚቀበልበት ሂሳብ አሁን ተቀይሯል። እርስዎ ካልሆኑ አሁኑኑ 2Pay ድጋፍን ያነጋግሩ።`);
