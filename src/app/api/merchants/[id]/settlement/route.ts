import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { cookies } from "next/headers";
import { requireMerchant, isAdminPhone } from "@/lib/guard";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { sendSettlementChangedSms } from "@/lib/sms";
import { STEP_UP_COOKIE, classifyChange, verifyStepUp } from "@/lib/settlement-security";
import { audit } from "@/lib/audit";
import { buildAccounts, isUuid, pickActive, toMasked, type SavedAccount, type SettlementView } from "@/lib/settlement";

export const dynamic = "force-dynamic";

const configError = () => NextResponse.json({ error: "Server misconfigured" }, { status: 500 });

interface Row {
  saved_banks: SavedAccount[] | null;
  saved_wallets: SavedAccount[] | null;
  active_bank: SavedAccount | null;
  active_wallet: SavedAccount | null;
}

const COLUMNS = "saved_banks, saved_wallets, active_bank, active_wallet";

/** Full account numbers never leave the server: the browser receives masked values only. */
function view(row: Row): SettlementView {
  return {
    saved_banks: (row.saved_banks ?? []).map(toMasked),
    saved_wallets: (row.saved_wallets ?? []).map(toMasked),
    active_bank_id: row.active_bank?.id ?? null,
    active_wallet_id: row.active_wallet?.id ?? null,
  };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed merchant id" }, { status: 400 });
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("merchants").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) {
      console.error("[settlement GET]", error.message);
      return NextResponse.json({ error: "Could not load settlement settings" }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });
    return NextResponse.json(view(data as Row));
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}

/**
 * Replace a merchant's saved accounts and choose the active ones.
 * SECURITY: this decides where customer money is routed. In test mode (AUTH_ENFORCED unset) anyone with the
 * link can call it; with AUTH_ENFORCED=true only that merchant's own OWNER session (or an admin) can, and removing or
 * editing an account, or switching the account money goes to, additionally needs a fresh step-up pass: a one-time code
 * sent only to the owner's registered phone (see /settlement/step-up). The very first setup is free, and adding an
 * extra account that is not activated changes nothing, so neither asks for a code.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed merchant id" }, { status: 400 });
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  try {
    const admin = getAdminClient();
    const { data: current, error: readErr } = await admin.from("merchants").select(COLUMNS).eq("id", id).maybeSingle();
    if (readErr) {
      console.error("[settlement PUT read]", readErr.message);
      return NextResponse.json({ error: "Could not load settlement settings" }, { status: 500 });
    }
    if (!current) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });
    const row = current as Row;

    const banks = buildAccounts("bank", body.banks, row.saved_banks ?? []);
    if (!banks.ok) return NextResponse.json({ error: banks.error }, { status: 400 });
    const wallets = buildAccounts("wallet", body.wallets, row.saved_wallets ?? []);
    if (!wallets.ok) return NextResponse.json({ error: wallets.error }, { status: 400 });

    const activeBank = pickActive("bank", banks.accounts, body.active_bank_id);
    if (!activeBank.ok) return NextResponse.json({ error: activeBank.error }, { status: 400 });
    const activeWallet = pickActive("wallet", wallets.accounts, body.active_wallet_id);
    if (!activeWallet.ok) return NextResponse.json({ error: activeWallet.error }, { status: 400 });

    // ---- the vault gate
    const kind = classifyChange(row, { saved_banks: banks.accounts, saved_wallets: wallets.accounts, active_bank: activeBank.active, active_wallet: activeWallet.active });
    const session = guard.session;
    if (kind === "SENSITIVE" && authEnforced() && session && !isAdminPhone(session.ph)) {
      const pass = (await cookies()).get(STEP_UP_COOKIE)?.value;
      if (!verifyStepUp(pass, id, session.ph, sessionSecret() ?? undefined)) {
        await audit(admin, session, req, { action: "settlement.blocked", targetType: "merchant", targetId: id, merchantId: id, details: { reason: "step-up required" } });
        return NextResponse.json({ error: "To change where your business receives money, confirm with the code we send to your registered phone.", code: "STEP_UP_REQUIRED" }, { status: 403 });
      }
    }

    const { data: saved, error } = await admin
      .from("merchants")
      .update({
        saved_banks: banks.accounts,
        saved_wallets: wallets.accounts,
        active_bank: activeBank.active,
        active_wallet: activeWallet.active,
      })
      .eq("id", id)
      .select(COLUMNS)
      .single();
    if (error) {
      console.error("[settlement PUT]", error.message);
      return NextResponse.json({ error: "Could not save settlement settings" }, { status: 500 });
    }
    await audit(admin, guard.session, req, {
      action: "settlement.update",
      targetType: "merchant",
      targetId: id,
      merchantId: id,
      details: { change: kind, banks: banks.accounts.length, wallets: wallets.accounts.length, active_bank: activeBank.active?.institution ?? null, active_wallet: activeWallet.active?.institution ?? null },
    });
    // A change to where money goes is told to the owner at once, so one they did not make is noticed straight away.
    if (kind === "SENSITIVE") {
      const { data: m } = await admin.from("merchants").select("phone, business_name").eq("id", id).maybeSingle();
      if (m?.phone) await sendSettlementChangedSms(m.phone, m.business_name ?? "your business").catch(() => false);
    }
    return NextResponse.json(view(saved as Row));
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}
