import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { normalizePhone } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MAX_STAFF = 10;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** The owner's cashiers. A cashier signs in with their own phone and can run the terminal and nothing else. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("merchant_staff").select("id, phone, name, role, active, created_at").eq("merchant_id", id).eq("active", true).order("created_at");
    if (error) return bad("Could not load your team", 500);
    return NextResponse.json((data ?? []).map((s) => ({ ...s, phone_masked: `${s.phone.slice(0, 7)}•••${s.phone.slice(-2)}`, phone: undefined })), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;

  const body = await req.json().catch(() => null);
  const phone = normalizePhone(body?.phone);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!phone) return bad("Enter a valid Ethiopian mobile number, e.g. 0911223344");
  if (name.length < 2 || name.length > 60) return bad("Enter the cashier's name (2–60 characters)");

  try {
    const admin = getAdminClient();
    const [{ data: owner }, { data: staff }, { count }] = await Promise.all([
      admin.from("merchants").select("id").eq("phone", phone).maybeSingle(),
      admin.from("merchant_staff").select("id").eq("phone", phone).eq("active", true).maybeSingle(),
      admin.from("merchant_staff").select("id", { count: "exact", head: true }).eq("merchant_id", id).eq("active", true),
    ]);
    if (owner || staff) return bad("That number already has a 2Pay account", 409);
    if ((count ?? 0) >= MAX_STAFF) return bad(`You can add up to ${MAX_STAFF} cashiers`, 409);

    const { data, error } = await admin.from("merchant_staff").insert({ merchant_id: id, phone, name }).select("id, name, role, created_at").single();
    if (error) {
      console.error("[staff POST]", error.message);
      return bad(error.code === "23505" ? "That number already has a 2Pay account" : "Could not add the cashier", error.code === "23505" ? 409 : 500);
    }
    await audit(admin, guard.session, req, { action: "staff.add", targetType: "staff", targetId: data.id, merchantId: id, details: { name, phone_last4: phone.slice(-4) } });
    return NextResponse.json({ ...data, phone_masked: `${phone.slice(0, 7)}•••${phone.slice(-2)}` }, { status: 201 });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
