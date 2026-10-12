/**
 * Content-Security-Policy.
 *  ENFORCED (safe on every page): pages can never be framed by another site, can't be given a different <base>, can't
 *  post forms to another site, and can't embed plugins.
 *  REPORT-ONLY (not enforced yet): the strict policy we want, with a violation report so it can be tightened from real
 *  traffic. It still allows inline scripts/styles because Next injects inline bootstrap scripts; removing 'unsafe-inline'
 *  needs per-request nonces and should be done and tested as its own change. Promote it to enforced once reports are clean.
 */
const enforced = ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join("; ");
const reportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // merchant ad images are https URLs
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: enforced },
  { key: "Content-Security-Policy-Report-Only", value: reportOnly },
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
    ];
  },
};
export default nextConfig;
