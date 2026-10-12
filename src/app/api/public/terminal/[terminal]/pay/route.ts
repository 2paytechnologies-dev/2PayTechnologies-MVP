import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { createPayNode } from "@/lib/pay-nodes";

export const dynamic = "force-dynamic";

const TERMINAL_ID = /^TRM-\d{4}$/;
/** Largest amount a customer may enter on a printed shop QR. The cashier terminal has no such cap. */
const MAX_STATIC_AMOUNT = Number(process.env.STATIC_QR_MAX_ETB) || 20_000;

/**
 * A customer scanned a shop's printed QR (or tapped its NFC sticker), typed an amount and pressed pay: create a pay
 * node for that shop and hand back its token, after which the normal checkout takes over. Because anyone on the
 * internet can call this, it is limited per payer and per shop, and the amount is capped.
 */
export async function POST(req: Request, { params }: { params: Promise<{ terminal: string }> }) {
  const { terminal } = await params;
  const id = terminal.toUpperCase();
  if (!TERMINAL_ID.test(id)) return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const amount = Math.round(Number(body?.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_STATIC_AMOUNT) {
    return NextResponse.json({ error: `Enter an amount between 1 and ${MAX_STATIC_AMOUNT.toLocaleString("en-US")} ETB` }, { status: 400 });
  }
  try {
    const admin = getAdminClient();
    const ip = clientIp(req);
    // Fail CLOSED: an unlimited public endpoint that creates database rows is an abuse magnet.
    if (!(await rateLimit(admin, `static-pay:ip:${ip}`, 10, 60, { failClosed: true })) || !(await rateLimit(admin, `static-pay:shop:${id}`, 60, 60, { failClosed: true }))) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
    }
    const { data: m } = await admin.from("merchants").select("id").eq("terminal_id", id).maybeSingle();
    if (!m) return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
    const r = await createPayNode(admin, m.id, amount, "STATIC_QR");
    if (!r.ok) return NextResponse.json(r.body, { status: r.status });
    return NextResponse.json({ token: (r.tx as { token: string }).token }, { status: 201 });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
