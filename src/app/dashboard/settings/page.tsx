import { redirect } from "next/navigation";

/** Settlement routing moved into the merchant portal as the "Get paid" tab. Old links and bookmarks still work. */
export default function SettingsRedirect() {
  redirect("/dashboard/merchant?tab=accounts");
}
