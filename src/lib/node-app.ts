import { authEnforced } from "@/lib/auth";

/**
 * Waiters take payments by tap, and a phone can only broadcast a tap from a native app: a web browser cannot emulate an NFC
 * card. So waiter accounts are for the 2Pay Android app. The app puts "TwoPayMerchantApp/<version>" in its user agent.
 *
 * This is a guard against honest mistakes (opening the link in Chrome), not a security boundary: a user agent can be
 * faked. What actually protects the account is the one-time code to the invited number and the binding to one phone.
 */
export const isNodeApp = (req: Request) => /TwoPayMerchantApp\//.test(req.headers.get("user-agent") ?? "");

/** Waiters must use the app when sign-in is enforced, unless the operator allows browsers (ALLOW_BROWSER_NODES=true). */
export const appRequiredFor = (role: string, req: Request) =>
  role === "WAITER" && authEnforced() && process.env.ALLOW_BROWSER_NODES !== "true" && !isNodeApp(req);

export const APP_REQUIRED_MESSAGE = "Waiter accounts work in the 2Pay Android app, which can tap to pay. Open this link on the phone where the app is installed.";