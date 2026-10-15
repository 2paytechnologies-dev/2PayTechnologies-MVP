/** The checkout-link secret is 43 URL-safe characters (256 bits, base64url). Kept in its own file so browser code never imports node:crypto. */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
