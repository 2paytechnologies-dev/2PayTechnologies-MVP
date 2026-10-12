import type { MetadataRoute } from "next";

/** Web app manifest. The Android app (android/) is a Trusted Web Activity that launches this site. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "2Pay Merchant",
    short_name: "2Pay",
    description: "2Pay merchant terminal and dashboard: take payments, track sales, run ads.",
    start_url: "/dashboard/merchant",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    categories: ["finance", "business"],
    icons: [
      { src: "/icons/icon-192.png?v=3", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=3", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png?v=3", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Cashier terminal", short_name: "Terminal", url: "/terminal", icons: [{ src: "/icons/icon-192.png?v=3", sizes: "192x192" }] },
      { name: "Settlement routing", short_name: "Routing", url: "/dashboard/settings", icons: [{ src: "/icons/icon-192.png?v=3", sizes: "192x192" }] },
    ],
  };
}
