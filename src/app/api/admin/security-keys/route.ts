import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit, clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { isLocked } from "@/lib/vault";
import { sendKeyResetSms } from "@/lib/sms";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const err = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * 2Pay support's recovery tool for a forgotten (or locked) security key. It never shows a key or a hash: there is nothing to
 * recover. A reset only removes the key, so the person must choose a new one, and doing that needs a code sent to their
 * registered phone (the enrolment routes). So a reset alone never lets anyone change a receiving account.
 */

/** Everyone who can approve account changes: owners and managers, with whether a key is set and whether it is locked. */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const [owners, managers] = await Promise.all([
      admin.from("merchants").select("id, business_name, terminal_id, phone, vault_pin_hash, vault_failed, vault_locked_until").order("business_name").limit(500),
      admin.from("merchant_staff").select("id, merchant_id, name, phone, team_no, vault_pin_hash, vault_failed, vault_locked_until").eq("role", "MANAGER").eq("active", true).limit(500),
    ]);
    if (owners.error || managers.error) return err("Could not load the approvers. Has supabase/v2_4.sql been run?", 500);
    const biz = new Map((owners.data ?? []).map((m) => [m.id as string, m]));
    const view = (kind: "OWNER" | "MANAGER", id: string, merchantId: string, name: string | null, phone: string | null, r: { vault_pin_hash: string | null; vault_failed: number | null; vault_locked_until: string | null }) => ({
      kind,
      id,
      merchant_id: merchantId,
      business: biz.get(merchantId)?.business_name ?? "",
      terminal: biz.get(merchantId)?.terminal_id ?? "",
      name,
      phone,
      has_key: !!r.vault_pin_hash,
      locked_until: isLocked({ failed: r.vault_failed ?? 0, lockedUntil: r.vault_locked_until }) ? r.vault_locked_until : null,
      failed: r.vault_failed ?? 0,
    });
    const approvers = [
      ...(owners.data ?? []).map((m) => view("OWNER", m.id, m.id, "Owner", m.phone, m)),
      ...(managers.data ?? []).map((s) => view("MANAGER", s.id, s.merchant_id, `${s.name} (${s.team_no})`, s.phone, s)),
    ];
    return NextResponse.json(approvers, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { kind: "OWNER" | "MANAGER", id, action: "reset" | "unlock", reason }. The reason is how you confirmed who is asking, and is kept in the audit log. */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const kind = body?.kind;
  const id = body?.id;
  const action = body?.action;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (kind !== "OWNER" && kind !== "MANAGER") return err("kind must be OWNER or MANAGER", 400);
  if (typeof id !== "string" || !isUuid(id)) return err("Malformed id", 400);
  if (action !== "reset" && action !== "unlock") return err("action must be reset or unlock", 400);
  if (reason.length < 10) return err("Write how you confirmed this person's identity (at least 10 characters). It is kept in the audit log.", 400);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `admin:vaultreset:${clientIp(req)}`, 20, 3600, { failClosed: true }))) return err("Too many resets. Try again later.", 429);

    // who is it, and which business
    let merchantId: string;
    let phone: string | null;
    let label: string;
    let row: { vault_pin_hash: string | null; vault_failed: number | null; vault_locked_until: string | null };
    if (kind === "OWNER") {
      const { data } = await admin.from("merchants").select("id, business_name, phone, vault_pin_hash, vault_failed, vault_locked_until").eq("id", id).maybeSingle();
      if (!data) return err("Business not found", 404);
      merchantId = data.id;
      phone = data.phone ?? null;
      label = data.business_name;
      row = data;
    } else {
      const { data } = await admin.from("merchant_staff").select("id, merchant_id, name, phone, role, active, vault_pin_hash, vault_failed, vault_locked_until").eq("id", id).maybeSingle();
      if (!data || data.role !== "MANAGER" || !data.active) return err("Manager not found", 404);
      merchantId = data.merchant_id;
      phone = data.phone ?? null;
      label = data.name;
      row = data;
    }
    const locked = isLocked({ failed: row.vault_failed ?? 0, lockedUntil: row.vault_locked_until });
    if (action === "reset" && !row.vault_pin_hash && !locked) return err("No security key is set, so there is nothing to reset.", 409);
    if (action === "unlock" && !locked && !(row.vault_failed ?? 0)) return err("This key is not locked.", 409);

    const patch = action === "reset" ? { vault_pin_hash: null, vault_pin_set_at: null, vault_failed: 0, vault_locked_until: null } : { vault_failed: 0, vault_locked_until: null };
    const { error } = await admin.from(kind === "OWNER" ? "merchants" : "merchant_staff").update(patch).eq("id", id);
    if (error) return err("Could not update", 500);

    if (action === "reset" && phone) {
      // codes already sent to that phone for account changes must not outlive the key they were meant to go with
      try { await admin.from("otp_challenges").delete().eq("phone", phone).eq("purpose", "stepup").is("consumed_at", null); } catch { /* best effort */ }
    }

    const { data: m } = await admin.from("merchants").select("business_name, phone").eq("id", merchantId).maybeSingle();
    await audit(admin, guard.session, req, {
      action: action === "reset" ? "vault.key_reset" : "vault.unlock",
      targetType: kind === "OWNER" ? "merchant" : "staff",
      targetId: id,
      merchantId,
      details: { approver: kind, reason, was_locked: locked },
    });

    if (action === "reset") {
      const business = m?.business_name ?? "your business";
      const who = kind === "OWNER" ? "the owner" : label;
      // the person whose key it was, and the owner (the same phone when it is the owner's own key)
      const targets = new Set([phone, m?.phone].filter((p): p is string => !!p));
      await Promise.all([...targets].map((p) => sendKeyResetSms(p, business, who)));
    }
    return NextResponse.json({ ok: true, action }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
