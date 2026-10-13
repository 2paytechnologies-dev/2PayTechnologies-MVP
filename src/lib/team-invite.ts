import type { StaffRole } from "@/lib/team";

/** Where the activation link points: the configured public address, else the address this request came to. */
export const siteOrigin = (req: Request) => (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "") || new URL(req.url).origin;

/** The link that opens straight inside the installed app (a custom scheme the app registers): twopay://activate/<token>. */
export const appLinkFor = (token: string) => `twopay://activate/${token}`;

/** The invitation text. Both languages, because the person may read either. */
export function inviteSms(p: { business: string; teamNo: string; role: StaffRole; link: string }): string {
  const roleEn = p.role === "WAITER" ? "waiter" : "cashier";
  const roleAm = p.role === "WAITER" ? "አስተናጋጅ" : "ገንዘብ ተቀባይ";
  return `2Pay: ${p.business} added you as a ${roleEn} (${p.teamNo}). Open on your phone to start: ${p.link}\n2Pay፦ ${p.business} እንደ ${roleAm} (${p.teamNo}) አክሎዎታል። ለመጀመር በስልክዎ ይክፈቱ፦ ${p.link}`;
}