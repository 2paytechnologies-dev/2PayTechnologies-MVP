import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { recordWatchdogEvent, safeEqual, type NewWatchdogEvent } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * Ingest endpoint for external compliance feeds that 2Pay cannot observe itself:
 *   ECR_MISMATCH    ECR / fiscal-memory totals vs settled totals (Ministry of Revenues integrity stream)
 *   FUEL_TELEMETRY  pump meter litres vs vehicle tank capacity vs settled amount
 *   AML_FIS         a Suspicious Activity Report raised by an upstream AML engine, queued for the FIS
 * Authenticated with the shared secret WATCHDOG_INGEST_SECRET in the `x-watchdog-secret` header.
 * Fails closed when the secret is not configured. The rules below decide whether an event is raised.
 */
export async function POST(req: Request) {
  const secret = process.env.WATCHDOG_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Ingest not configured" }, { status: 503 });
  if (!safeEqual(secret, req.headers.get("x-watchdog-secret") ?? "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.type !== "string") return NextResponse.json({ error: "type is required" }, { status: 400 });

  try {
    const admin = getAdminClient();

    let merchantId: string | null = null;
    if (typeof body.terminal_id === "string") {
      const { data } = await admin.from("merchants").select("id").eq("terminal_id", body.terminal_id).maybeSingle();
      merchantId = data?.id ?? null;
      if (!merchantId) return NextResponse.json({ error: "Unknown terminal_id" }, { status: 404 });
    }
    const transactionId = typeof body.transaction_id === "string" && UUID.test(body.transaction_id) ? body.transaction_id : null;

    let evt: NewWatchdogEvent | null = null;

    if (body.type === "ECR_MISMATCH") {
      const ecr = num(body.ecr_total);
      const settled = num(body.settled_total);
      if (!Number.isFinite(ecr) || !Number.isFinite(settled) || ecr < 0 || settled < 0) {
        return NextResponse.json({ error: "ecr_total and settled_total must be non-negative numbers" }, { status: 400 });
      }
      const delta = Math.round((ecr - settled) * 100) / 100;
      if (Math.abs(delta) > 0.5) {
        const pct = settled > 0 ? Math.abs(delta) / settled : 1;
        evt = {
          event_type: "ECR_MISMATCH",
          severity: pct >= 0.05 ? "CRITICAL" : "HIGH",
          risk_score: Math.min(100, 60 + Math.round(pct * 400)),
          message: `ECR fiscal memory shows ${ecr} ETB but ${settled} ETB settled (Δ ${delta}).`,
          details: { ecr_total: ecr, settled_total: settled, delta, fiscal_receipt_no: body.fiscal_receipt_no ?? null },
        };
      }
    } else if (body.type === "FUEL_TELEMETRY") {
      const liters = num(body.liters);
      const tank = num(body.tank_capacity_liters);
      const settled = num(body.settled_amount);
      const price = num(body.price_per_liter);
      if (![liters, tank, settled].every((n) => Number.isFinite(n) && n >= 0)) {
        return NextResponse.json({ error: "liters, tank_capacity_liters and settled_amount are required" }, { status: 400 });
      }
      const flags: string[] = [];
      if (liters > tank * 1.02) flags.push(`pump dispensed ${liters} L into a ${tank} L tank`);
      const expected = Number.isFinite(price) ? Math.round(liters * price * 100) / 100 : null;
      if (expected != null && Math.abs(expected - settled) > Math.max(1, expected * 0.01)) {
        flags.push(`${liters} L @ ${price} = ${expected} ETB but ${settled} ETB settled`);
      }
      if (flags.length) {
        evt = {
          event_type: "FUEL_TELEMETRY",
          severity: flags.length > 1 ? "CRITICAL" : "HIGH",
          risk_score: flags.length > 1 ? 92 : 78,
          message: `Forecourt anomaly: ${flags.join("; ")}.`,
          details: { liters, tank_capacity_liters: tank, settled_amount: settled, price_per_liter: Number.isFinite(price) ? price : null, expected_amount: expected },
        };
      }
    } else if (body.type === "AML_FIS") {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";
      if (!reason) return NextResponse.json({ error: "reason is required" }, { status: 400 });
      evt = {
        event_type: "AML_FIS_SAR",
        severity: "HIGH",
        risk_score: Math.min(100, Math.max(60, Math.round(num(body.risk_score) || 80))),
        message: `Suspicious Activity Report queued for FIS: ${reason}`,
        details: { fis_status: "PENDING_FILING", reason },
      };
    } else {
      return NextResponse.json({ error: `Unsupported type "${body.type}"` }, { status: 400 });
    }

    if (!evt) return NextResponse.json({ flagged: false });
    const ok = await recordWatchdogEvent(admin, { ...evt, merchant_id: merchantId, transaction_id: transactionId });
    return ok ? NextResponse.json({ flagged: true }, { status: 201 }) : NextResponse.json({ error: "Could not record event" }, { status: 500 });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
