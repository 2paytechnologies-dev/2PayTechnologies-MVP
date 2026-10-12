# End-to-end tests

These exercise the real route handlers against a small in-memory stand-in for Supabase (`mock-postgrest.mjs`), and make
one real call to Arifpay's public **sandbox** (session creation). They need no database, secrets or accounts.

```powershell
# 1. the stand-in database
node tests/e2e/mock-postgrest.mjs

# 2. the app, pointed at it, with enforcement and the live rail ON (set these in the same shell, then run next dev)
$env:NEXT_PUBLIC_SUPABASE_URL="http://localhost:4020"; $env:SUPABASE_SERVICE_ROLE_KEY="service"
$env:AUTH_ENFORCED="true"; $env:SESSION_SECRET="q"*48; $env:ADMIN_PHONES="0711000111"
$env:RAIL_MODE="live"; $env:PUBLIC_BASE_URL="http://localhost:3170"; $env:ARIFPAY_WEBHOOK_SECRET="unit-test-webhook-secret-0123456789"
$env:SMS_WEBHOOK_URL="http://localhost:4030"; $env:CRON_SECRET="cron-secret-for-tests"; $env:KYC_REQUIRED_FOR_LIVE="true"
npx next dev -p 3170

# 3. the tests (Node 24+)
node --experimental-transform-types --no-warnings tests/e2e/e2e.mjs
```

Unit tests (`npm test`) cover the pure logic and need none of this.
