import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { cookies } from "next/headers";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { sendSettlementChangedSms } from "@/lib/sms";
import { STEP_UP_COOKIE, classifyChange, needsStepUp, verifyStepUp } from "@/lib/settlement-security";
import { resolveApprover } from "@/lib/vault";
import { openAccount, openAccounts, sealAccount, sealAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { audit } from "@/lib/audit";
import { buildAccounts, isUuid, pickActive, toMasked, type SavedAccount, type SettlementView } from "@/lib/settlement";

export const dynamic = "force-dynamic";

const configError = () => NextResponse.json({ error: "Server misconfigured" }, { status: 500 });

/** A row as stored: account numbers may be encrypted (see fieldcrypt.ts). */
interface Stored {
  saved_banks: StoredAccount[] | null;
  saved_wallets: StoredAccount[] | null;
  active_bank: StoredAccount | null;
  active_wallet: StoredAccount | null;
}
/** The same row with the numbers readable, for use on the server only. */
interface Row {
  saved_banks: SavedAccount[];
  saved_wallets: SavedAccount[];
  active_bank: SavedAccount | null;
  active_wallet: SavedAccount | null;
}

const COLUMNS = "saved_banks, saved_wallets, active_bank, active_wallet";

/**
 * Decrypt a stored row. If any number cannot be decrypted (the key is missing or wrong) it says so, and the caller refuses to
 * write: saving would otherwise silently drop the accounts it could not read.
 */
function openRow(s: Stored): { row: Row; broken: boolean } {
  const banks = openAccounts(s.saved_banks);
  const wallets = openAccounts(s.saved_wallets);
  const bank = openAccount(s.active_bank);
  const wallet = openAccount(s.active_wallet);
  const broken = banks.length !== (s.saved_banks ?? []).length || wallets.length !== (s.saved_wallets ?? []).length || (!!s.active_bank && !bank) || (!!s.active_wallet && !wallet);
  return { row: { saved_banks: banks, saved_wallets: wallets, active_bank: bank, active_wallet: wallet }, broken };
}

/** Full account numbers never leave the server: the browser receives masked values only. */
function view(row: Row): SettlementView {
  return {
    saved_banks: row.saved_banks.map(toMasked),
    saved_wallets: row.saved_wallets.map(toMasked),
    active_bank_id: row.active_bank?.id ?? null,
    active_wallet_id: row.active_wallet?.id ?? null,
  };
}

const unreadable = () => NextResponse.json({ error: "The saved account numbers cannot be read: check DATA_ENCRYPTION_KEY. Nothing was changed." }, { status: 503 });

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed merchant id" }, { status: 400 });
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("merchants").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) {
      console.error("[settlement GET]", error.message);
      return NextResponse.json({ error: "Could not load settlement settings" }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "Merchant not found" }, { status: 404 });
    const { row, broken } = openRow(data as Stored);
    if (broken) return unreadable();
    return NextResponse.json(view(row));
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}

/**
 * Replace a merchant's saved accounts and choose the active ones.
 *
 * SECURITY (the settlement vault): this decides where customer money lands. Adding, editing or removing ANY receiving
 * account, or switching the active one, needs the approver's security key AND a one-time code sent to the approver's own
 * phone (the owner, or a manager the owner appointed), proven by a short-lived signed pass (see /settlement/vault and
 * /settlement/step-up). This holds in the open test mode too: with no session the approver is the business owner, so
 * "anyone with the link" can never change where money goes. Cashiers and waiters are refused outright. Account numbers are
 * stored encrypted (fieldcrypt.ts) and every change is written to an append-only history by the database.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed merchant id" }, { status: 400 });
  const guard = await requireMerchant(id, { vault: true });
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
    const { row, broken } = openRow(current as Stored);
    if (broken) return unreadable();

    const banks = buildAccounts("bank", body.banks, row.saved_banks);
    if (!banks.ok) return NextResponse.json({ error: banks.error }, { status: 400 });
    const wallets = buildAccounts("wallet", body.wallets, row.saved_wallets);
    if (!wallets.ok) return NextResponse.json({ error: wallets.error }, { status: 400 });

    const activeBank = pickActive("bank", banks.accounts, body.active_bank_id);
    if (!activeBank.ok) return NextResponse.json({ error: activeBank.error }, { status: 400 });
    const activeWallet = pickActive("wallet", wallets.accounts, body.active_wallet_id);
    if (!activeWallet.ok) return NextResponse.json({ error: activeWallet.error }, { status: 400 });

    // ---- the vault gate
    const kind = classifyChange(row, { saved_banks: banks.accounts, saved_wallets: wallets.accounts, active_bank: activeBank.active, active_wallet: activeWallet.active });
    const session = guard.session;
    let approverKind: "OWNER" | "MANAGER" = "OWNER";
    if (needsStepUp(kind)) {
      const a = await resolveApprover(admin, id, session);
      if (!a) {
        await audit(admin, session, req, { action: "settlement.blocked", targetType: "merchant", targetId: id, merchantId: id, details: { reason: "not an approver" } });
        return NextResponse.json({ error: "Only the owner or a manager can change payment accounts." }, { status: 403 });
      }
      approverKind = a.kind;
      if (!a.phone || !a.hasPin) {
        return NextResponse.json({ error: "Set up your security key to manage payment accounts.", code: "VAULT_SETUP_REQUIRED", need: !a.phone ? "phone" : "pin" }, { status: 403 });
      }
      const pass = (await cookies()).get(STEP_UP_COOKIE)?.value;
      if (!verifyStepUp(pass, id, a.id, a.phone, sessionSecret() ?? undefined)) {
        await audit(admin, session, req, { action: "settlement.blocked", targetType: "merchant", targetId: id, merchantId: id, details: { reason: "step-up required", approver: a.kind } });
        return NextResponse.json({ error: "To change where your business receives money, confirm with your security key and the code we send to your phone.", code: "STEP_UP_REQUIRED" }, { status: 403 });
      }
    }

    const { data: saved, error } = await admin
      .from("merchants")
      .update({
        saved_banks: sealAccounts(banks.accounts),
        saved_wallets: sealAccounts(wallets.accounts),
        active_bank: activeBank.active ? sealAccount(activeBank.active) : null,
        active_wallet: activeWallet.active ? sealAccount(activeWallet.active) : null,
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
      details: { change: kind, approver: approverKind, banks: banks.accounts.length, wallets: wallets.accounts.length, active_bank: activeBank.active?.institution ?? null, active_wallet: activeWallet.active?.institution ?? null },
    });
    // A change to where money goes is told to the OWNER at once (even when a manager made it), so one they did not expect is noticed straight away.
    if (needsStepUp(kind)) {
      const { data: m } = await admin.from("merchants").select("phone, business_name").eq("id", id).maybeSingle();
      if (m?.phone) await sendSettlementChangedSms(m.phone, m.business_name ?? "your business").catch(() => false);
    }
    return NextResponse.json(view(openRow(saved as Stored).row));
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}