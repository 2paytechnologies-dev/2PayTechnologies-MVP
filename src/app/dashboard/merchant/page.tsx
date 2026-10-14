"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, CalendarClock, FlaskConical, LogIn, LogOut, Megaphone, Nfc, Store, UserCog, Users, Wallet } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { UpdateBanner } from "@/components/UpdateBanner";
import { TerminalPanel } from "@/components/TerminalPanel";
import { cachedPortal, fetchPortal, forgetPortal, type Portal, type SessionInfo } from "@/lib/client-session";
import { setNodeMode } from "@/lib/native";
import { useT, type Key } from "@/lib/i18n";
import type { Merchant } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The terminal is what opens first, so it is in the first download. Every other tab is its own small download, fetched
 * quietly in the background right after the terminal is on screen (so the first tap on a tab is instant) and kept alive
 * once opened (so coming back to a tab is instant and keeps what you were looking at).
 */
const loaders = {
  accounts: () => import("@/components/merchant/PaymentAccountsTab").then((m) => m.PaymentAccountsTab),
  sales: () => import("@/components/merchant/LookbackTab").then((m) => m.LookbackTab),
  today: () => import("@/components/merchant/BriefingTab").then((m) => m.BriefingTab),
  ads: () => import("@/components/merchant/CampaignsTab").then((m) => m.CampaignsTab),
  team: () => import("@/components/merchant/TeamTab").then((m) => m.TeamTab),
  profile: () => import("@/components/merchant/ProfileTab").then((m) => m.ProfileTab),
};
const TabSkeleton = () => (
  <div className="space-y-3" aria-busy="true">
    <div className="h-7 w-40 animate-pulse rounded-lg bg-slate-800" />
    <div className="h-24 animate-pulse rounded-2xl bg-slate-900" />
    <div className="h-24 animate-pulse rounded-2xl bg-slate-900" />
  </div>
);
const PaymentAccountsTab = dynamic(loaders.accounts, { loading: TabSkeleton });
const LookbackTab = dynamic(loaders.sales, { loading: TabSkeleton });
const BriefingTab = dynamic(loaders.today, { loading: TabSkeleton });
const CampaignsTab = dynamic(loaders.ads, { loading: TabSkeleton });
const TeamTab = dynamic(loaders.team, { loading: TabSkeleton });
const ProfileTab = dynamic(loaders.profile, { loading: TabSkeleton });

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

/** A tab left for longer than this is rebuilt (fresh data) when you come back; sooner than this it is shown as you left it. */
const STALE_MS = 60_000;

export default function MerchantPortalPage() {
  const t = useT();
  const router = useRouter();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [tab, setTab] = useState<TabId>("terminal");
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(new Set<TabId>(["terminal"]));
  const [epoch, setEpoch] = useState<Record<string, number>>({});
  const [welcome, setWelcome] = useState(false);
  const [saleActive, setSaleActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [fresh, setFresh] = useState(false); // false while only the remembered copy is on screen
  const leftAt = useRef<Record<string, number>>({});

  const apply = useCallback((p: Portal, isFresh: boolean) => {
    setMerchants(p.merchants);
    setSession(p.session);
    setMerchantId((cur) => (cur && p.merchants.some((m) => m.id === cur) ? cur : p.defaultMerchantId));
    if (isFresh) setFresh(true);
  }, []);

  const loadPortal = useCallback(async () => {
    try {
      const p = await fetchPortal();
      if (p) {
        setError(null);
        apply(p, true);
        return p.merchants;
      }
      setError(t("common.errorGeneric"));
    } catch {
      setError(t("common.offline"));
    }
    return [] as Merchant[];
  }, [apply, t]);

  useEffect(() => {
    // 1) paint what was on screen last time, at once; 2) replace it with the live answer (one request).
    const cached = cachedPortal();
    if (cached) apply(cached, false);
    void loadPortal();
    // Deep links: /dashboard/merchant?tab=ads  (and ?welcome=1 right after registering)
    const q = new URLSearchParams(window.location.search);
    const wanted = ALL_TABS.find((x) => x.id === q.get("tab"));
    if (wanted) {
      setTab(wanted.id);
      setVisited((v) => new Set(v).add(wanted.id));
    }
    if (q.get("welcome") === "1") setWelcome(true);
  }, [apply, loadPortal]);

  // Warm the other tabs' code once the terminal has had a moment to settle.
  useEffect(() => {
    if (!fresh) return;
    const warm = () => Object.values(loaders).forEach((load) => void load().catch(() => {}));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, [fresh]);

  const role = session?.role ?? "OWNER"; // test mode has no session: everything is open
  // A waiter's or cashier's phone is a payment terminal and nothing else (a no-op outside the Android app).
  useEffect(() => {
    if (session) setNodeMode((role === "WAITER" || role === "CASHIER") && !!session.merchant);
  }, [session, role]);

  const tabs = useMemo(() => (role === "OWNER" ? ALL_TABS : role === "MANAGER" ? ALL_TABS.filter((x) => x.id === "terminal" || x.id === "accounts") : ALL_TABS.filter((x) => x.id === "terminal")), [role]);
  const merchant = merchants.find((m) => m.id === merchantId);
  const needsSetup = !!merchant?.routing && !merchant.routing.bank && !merchant.routing.wallet && (role === "OWNER" || role === "MANAGER");

  const go = (id: TabId) => {
    // Remember when the tab we are leaving was last on screen; rebuild the one we are entering if it has gone stale.
    leftAt.current[tab] = Date.now();
    const left = leftAt.current[id];
    if (left && Date.now() - left > STALE_MS && id !== "terminal") setEpoch((e) => ({ ...e, [id]: (e[id] ?? 0) + 1 }));
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    try {
      history.replaceState(null, "", `?tab=${id}`);
    } catch {
      /* ignore */
    }
  };

  const signOut = async () => {
    forgetPortal();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/signin");
    router.refresh();
  };

  const body = (id: Exclude<TabId, "terminal">, node: React.ReactNode) =>
    merchant && visited.has(id) ? (
      <div hidden={tab !== id} key={`${merchant.id}:${id}:${epoch[id] ?? 0}`}>
        {node}
      </div>
    ) : null;
  const canOwn = role === "OWNER";
  const canAccounts = role === "OWNER" || role === "MANAGER";

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

      {error && !merchant && <div className="mb-4 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {!merchant && !error && <TabSkeleton />}

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
              onNeedSetup={canAccounts ? () => go("accounts") : undefined}
              role={role}
              staff={session?.staff ?? null}
            />
          </div>
          {canAccounts && body("accounts", <PaymentAccountsTab merchant={merchant} welcome={welcome} onChanged={() => void loadPortal()} onOpenTerminal={() => go("terminal")} />)}
          {canOwn && body("sales", <LookbackTab merchant={merchant} />)}
          {canOwn && body("today", <BriefingTab merchant={merchant} />)}
          {canOwn && body("ads", <CampaignsTab merchant={merchant} />)}
          {canOwn && body("team", <TeamTab merchant={merchant} />)}
          {canOwn && body("profile", <ProfileTab merchant={merchant} onSignOut={signOut} signedIn={!!session?.merchant} />)}
        </>
      )}
    </main>
  );
}
