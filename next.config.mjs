/**
 * Content-Security-Policy, ENFORCED in production: nothing loads from, or is sent to, any other site (scripts, fonts, media,
 * workers, connections; images only over https for merchants' ad pictures), and a page can never be framed or given another
 * <base> or form target. Inline scripts/styles are still allowed because Next injects its bootstrap inline; removing
 * 'unsafe-inline' needs per-request nonces and is its own change. Development also needs eval for hot reload.
 */
const dev = process.env.NODE_ENV !== "production";
// When the screens and the in-country API are on different hosts, the browser may talk to that API host too (and only that one).
const apiOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_API_BASE ? new URL(process.env.NEXT_PUBLIC_API_BASE).origin : "";
  } catch {
    return "";
  }
})();
const enforced = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // merchants' ad pictures are https URLs
  "font-src 'self' data:",
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ""}${dev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const securityHeaders = [
  { key: "Content-Security-Policy", value: enforced },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" }, // pay and terminal screens must never be framed by another site
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker must always be re-checked so a fixed version reaches phones immediately.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, max-age=0" }] },
      // The update manifest must never be served stale, or phones would not learn about a new version.
      { source: "/downloads/latest.json", headers: [{ key: "Cache-Control", value: "no-cache, max-age=0" }] },
      // Icons and the recorded Amharic word never change at a given address (they are linked with ?v=N and N is bumped when
      // they change), so a phone keeps them for a year instead of asking the server about them on every open.
      { source: "/icons/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/sounds/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/favicon.ico", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }] },
      { source: "/icon.png", headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" }] },
      // Everything under /api is about one person or one payment: never stored by a shared cache.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};
export default nextConfig;
