/** Baseline security headers for every response. (A strict CSP is intentionally not set here: it needs
 *  per-request nonces for Next's inline scripts and should be added and tested separately.) */
const securityHeaders = [
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
    ];
  },
};
export default nextConfig;
