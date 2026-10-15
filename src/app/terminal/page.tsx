"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { TerminalPanel } from "@/components/TerminalPanel";
import { RideTerminal } from "@/components/RideTerminal";
import { SESSION_TOKEN_RE } from "@/lib/ride-token";
import { cachedPortal, fetchPortal, type Role, type SessionInfo } from "@/lib/client-session";
import { useT } from "@/lib/i18n";
import type { Merchant } from "@/lib/types";

/** `/terminal?session_token=...` is a ride-hailing checkout (the driver's phone, no sign-in); anything else is the merchant's own terminal. */
export default function TerminalPage() {
  const [ride, setRide] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const tok = new URLSearchParams(window.location.search).get("session_token");
    setRide(tok && SESSION_TOKEN_RE.test(tok) ? tok : null);
  }, []);
  if (ride === undefined) return null;
  if (ride) return <RideTerminal sessionToken={ride} />;
  return <MerchantTerminal />;
}

function MerchantTerminal() {
  const t = useT();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [role, setRole] = useState<Role>("OWNER");
  const [staff, setStaff] = useState<SessionInfo["staff"]>(null);

  useEffect(() => {
    // Paint what was on screen last time at once, then replace it with the live answer (one request for everything).
    const cached = cachedPortal();
    if (cached) {
      setMerchants(cached.merchants);
      setMerchantId(cached.defaultMerchantId);
    }
    fetchPortal()
      .then((p) => {
        if (!p) return setError(t("common.errorGeneric"));
        setMerchants(p.merchants);
        setMerchantId((cur) => (cur && p.merchants.some((m) => m.id === cur) ? cur : p.defaultMerchantId));
        setRole(p.session.role);
        setStaff(p.session.staff);
      })
      .catch(() => setError(t("common.offline")));
  }, [t]);
  const merchant = merchants.find((m) => m.id === merchantId);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <span className="font-semibold">{t("portal.tab.terminal")}</span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageMenu />
          {merchants.length > 1 && (
            <select
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              disabled={locked}
              aria-label={t("portal.merchant")}
              className="max-w-[10rem] rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            >
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.business_name} · {m.terminal_id}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {merchantId && (
        <TerminalPanel key={merchantId} merchantId={merchantId} merchantName={merchant?.business_name} category={merchant?.category} routing={merchant?.routing} onActiveChange={setLocked} role={role} staff={staff} />
      )}
    </main>
  );
}
