"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, CalendarClock, FlaskConical, LogIn, LogOut, Megaphone, Nfc, Store, UserCog, Users, Wallet } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { UpdateBanner } from "@/components/UpdateBanner";
import { TerminalPanel } from "@/components/TerminalPanel";
import { PaymentAccountsTab } from "@/components/merchant/PaymentAccountsTab";
import { LookbackTab } from "@/components/merchant/LookbackTab";
import { BriefingTab } from "@/components/merchant/BriefingTab";
import { CampaignsTab } from "@/components/merchant/CampaignsTab";
import { TeamTab } from "@/components/merchant/TeamTab";
import { ProfileTab } from "@/components/merchant/ProfileTab";
import { defaultMerchantId, fetchSession, type SessionInfo } from "@/lib/client-session";
import { setNodeMode } from "@/lib/native";
import { useT, type Key } from "@/lib/i18n";
import type { Merchant } from "@/lib/types";
import { cn } from "@/lib/utils";

const ALL_TABS = [
  { id: "terminal", key: "portal.tab.terminal", icon: Nfc },
  { id: "accounts", key: "portal.tab.accounts", icon: Wallet },
  { id: "sales", key: "portal.tab.sales", icon: CalendarClock },
  { id: "today", key: "portal.tab.today", icon: BarChart3 },
  { id: "ads", key: "portal.tab.ads", icon: Megaphone },
  { id: "team", key: "portal.tab.team", icon: Users },
  { id: "profile", key: "portal.tab.profile", icon: UserCog },
] as const satisfies readonly { id: string; key: Key; icon: unknown }[];
type TabId = (typeof ALL_TABS)[number]["id"];

export default function MerchantPortalPage() {
  const t = useT();
  const router = useRouter();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [tab, setTab] = useState<TabId>("terminal");
  const [welcome, setWelcome] = useState(false);
  const [saleActive, setSaleActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const loadMerchants = useCallback(async () => {
    try {
      const r = await fetch("/api/merchants", { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d) && d.length) {
        setMerchants(d);
        setMerchantId((cur) => cur || "");
        return d as Merchant[];
      }
      setError(d?.error ?? "No merchants found");
    } catch {
      setError(t("common.offline"));
    }
    return [] as Merchant[];
  }, [t]);

  useEffect(() => {
    void loadMerchants().then((list) => {
      if (list.length) void defaultMerchantId(list).then(setMerchantId);
    });
    void fetchSession().then(setSession);
    // Deep links: /dashboard/merchant?tab=ads  (and ?welcome=1 right after registering)
    const q = new URLSearchParams(window.location.search);
    const wanted = ALL_TABS.find((x) => x.id === q.get("tab"));
    if (wanted) setTab(wanted.id);
    if (q.get("welcome") === "1") setWelcome(true);
  }, [loadMerchants]);

  const role = session?.role ?? "OWNER"; // test mode has no session: everything is open
  // A waiter's or cashier's phone is a payment terminal and nothing else (a no-op outside the Android app).
  useEffect(() => {
    if (session) setNodeMode(role !== "OWNER" && !!session.merchant);
  }, [session, role]);
  const tabs = useMemo(() => (role !== "OWNER" ? ALL_TABS.filter((x) => x.id === "terminal") : ALL_TABS), [role]); // cashiers and waiters get the terminal only
  const merchant = merchants.find((m) => m.id === merchantId);
  const needsSetup = !!merchant?.routing && !merchant.routing.bank && !merchant.routing.wallet && role === "OWNER";

  const go = (id: TabId) => {
    setTab(id);
    try {
      history.replaceState(null, "", `?tab=${id}`);
    } catch {
      /* ignore */
    }
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/signin");
    router.refresh();
  };

  return (
    <main className="mx-auto max-w-5xl p-4 pb-16 sm:p-8">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <h1 className="text-lg font-bold text-white sm:text-xl">{t("portal.title")}</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
          <LanguageMenu />
          {merchants.length > 1 && (
            <select
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              disabled={saleActive}
              aria-label={t("portal.merchant")}
              className="max-w-[11rem] rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 disabled:opacity-50"
            >
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.business_name} · {m.terminal_id}
                </option>
              ))}
            </select>
          )}
          {session?.merchant ? (
            <button onClick={signOut} className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200" title={t("portal.signedInAs", { name: session.merchant.business_name })}>
              <LogOut className="h-4 w-4" /> {t("common.signOut")}
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">{t(role === "OWNER" ? "portal.role.OWNER" : role === "WAITER" ? "portal.role.WAITER" : "portal.role.CASHIER")}</span>
            </button>
          ) : (
            <Link href="/signin" className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200">
              <LogIn className="h-4 w-4" /> {t("common.signIn")}
            </Link>
          )}
        </div>
      </header>

      <UpdateBanner />

      {session?.railMode === "simulated" && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" /> {t("portal.demoBanner")}
        </div>
      )}

      {needsSetup && tab !== "accounts" && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <Store className="h-6 w-6 shrink-0 text-amber-400" />
          <div className="min-w-[12rem] flex-1">
            <div className="font-semibold">{t("portal.setup.title")}</div>
            <div className="text-sm text-amber-100/80">{t("portal.setup.body")}</div>
          </div>
          <button onClick={() => go("accounts")} className="rounded-xl bg-amber-400 px-4 py-2 font-bold text-slate-950">
            {t("portal.setup.cta")}
          </button>
        </div>
      )}

      {tabs.length > 1 && (
        <nav className="mb-6 flex gap-1 overflow-x-auto rounded-2xl bg-slate-900 p-1 text-sm" role="tablist">
          {tabs.map(({ id, key, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => go(id)}
              className={cn("flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 font-medium", tab === id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}
            >
              <Icon className="h-4 w-4" /> {t(key)}
              {id === "accounts" && needsSetup && <span className="h-2 w-2 rounded-full bg-amber-400" />}
            </button>
          ))}
        </nav>
      )}

      {error && <div className="mb-4 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {merchant && (
        <>
          {/* The terminal stays mounted so a sale in progress survives tab switches. */}
          <div hidden={tab !== "terminal"}>
            <TerminalPanel
              key={merchant.id}
              merchantId={merchant.id}
              merchantName={merchant.business_name}
              category={merchant.category}
              routing={merchant.routing}
              onActiveChange={setSaleActive}
              onNeedSetup={role === "OWNER" ? () => go("accounts") : undefined}
              role={role}
              staff={session?.staff ?? null}
            />
          </div>
          {role === "OWNER" && tab === "accounts" && (
            <PaymentAccountsTab key={merchant.id} merchant={merchant} welcome={welcome} onChanged={() => void loadMerchants()} onOpenTerminal={() => go("terminal")} />
          )}
          {role === "OWNER" && tab === "sales" && <LookbackTab key={merchant.id} merchant={merchant} />}
          {role === "OWNER" && tab === "today" && <BriefingTab key={merchant.id} merchant={merchant} />}
          {role === "OWNER" && tab === "ads" && <CampaignsTab key={merchant.id} merchant={merchant} />}
          {role === "OWNER" && tab === "team" && <TeamTab key={merchant.id} merchant={merchant} />}
          {role === "OWNER" && tab === "profile" && <ProfileTab key={merchant.id} merchant={merchant} onSignOut={signOut} signedIn={!!session?.merchant} />}
        </>
      )}
    </main>
  );
}
