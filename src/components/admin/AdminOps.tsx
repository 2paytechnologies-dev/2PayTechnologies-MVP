"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Car, ClipboardList, Fingerprint, Landmark, Loader2, RotateCcw, Siren } from "lucide-react";
import { FaydaTracker } from "@/components/admin/FaydaTracker";
import { ComplianceAudit } from "@/components/admin/ComplianceAudit";
import { fmt, formatEAT } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab = "refunds" | "kyc" | "fayda" | "nbe" | "partners" | "audit" | "errors";
const TABS: { id: Tab; label: string; icon: typeof RotateCcw }[] = [
  { id: "refunds", label: "Refund requests", icon: RotateCcw },
  { id: "kyc", label: "Verification", icon: BadgeCheck },
  { id: "fayda", label: "Fayda KYC", icon: Fingerprint },
  { id: "nbe", label: "NBE compliance", icon: Landmark },
  { id: "partners", label: "Ride partners", icon: Car },
  { id: "audit", label: "Audit log", icon: ClipboardList },
  { id: "errors", label: "App errors", icon: Siren },
];

/** Operations console for the admin hub (English only: it is for 2Pay staff). */
export function AdminOps() {
  const [tab, setTab] = useState<Tab>("refunds");
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex gap-1 overflow-x-auto border-b border-slate-800 p-2 text-sm">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 font-medium", tab === id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      <div className="p-4">
        {tab === "refunds" && <Refunds />}
        {tab === "kyc" && <Kyc />}
        {tab === "fayda" && <FaydaTracker />}
        {tab === "nbe" && <ComplianceAudit />}
        {tab === "partners" && <RidePartners />}
        {tab === "audit" && <Table url="/api/admin/audit?limit=100" empty="No audit entries yet." cols={["Time (EAT)", "Actor", "Role", "Action", "Target", "IP", "Details"]} row={(r) => [formatEAT(r.created_at), r.actor_phone ?? "—", r.role ?? "—", r.action, `${r.target_type ?? ""} ${String(r.target_id ?? "").slice(0, 8)}`, r.ip ?? "", JSON.stringify(r.details ?? {})]} />}
        {tab === "errors" && <Table url="/api/admin/errors" empty="No errors reported." cols={["Time (EAT)", "Source", "Message", "Page", "Device"]} row={(r) => [formatEAT(r.created_at), r.source, r.message, r.url ?? "", String(r.user_agent ?? "").slice(0, 60)]} />}
      </div>
    </section>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function useList(url: string) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Could not load");
      setRows(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, error, load };
}

function Table({ url, cols, row, empty }: { url: string; cols: string[]; row: (r: Row) => string[]; empty: string }) {
  const { rows, error } = useList(url);
  if (!rows) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  return (
    <div className="overflow-x-auto">
      {error && <p className="mb-3 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
          <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-slate-500">{empty}</td></tr>}
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className="border-b border-slate-800/60 align-top last:border-0">
              {row(r).map((c, j) => <td key={j} className="max-w-xs break-words px-3 py-2 text-slate-300">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionRow({ id, base, actions, onDone }: { id: string; base: string; actions: { label: string; status: string; needsNote?: boolean; tone?: string }[]; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (status: string, needsNote?: boolean) => {
    if (needsNote && !note.trim()) return setErr("Give a reason first");
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${base}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note, admin_note: note }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the merchant (required to reject)" maxLength={300} className="h-9 w-full min-w-[12rem] rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs" />
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <button key={a.status} disabled={busy} onClick={() => go(a.status, a.needsNote)} className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold disabled:opacity-50", a.tone ?? "bg-slate-700 text-white")}>
            {a.label}
          </button>
        ))}
      </div>
      {err && <p className="text-xs text-rose-300">{err}</p>}
    </div>
  );
}

function Refunds() {
  const { rows, error, load } = useList("/api/admin/refunds");
  if (!rows) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
      <p className="text-xs text-slate-500">Approve, return the money through the payment provider, then mark it refunded. A rejection needs a reason the merchant will see.</p>
      {rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No refund requests.</p>}
      {rows.map((r) => (
        <div key={r.id} className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm md:grid-cols-[1fr_auto]">
          <div className="space-y-0.5">
            <div className="font-semibold">
              {fmt(Number(r.amount))} ETB <span className="font-mono text-xs font-normal text-slate-500">{r.reference}</span>
            </div>
            <div className="text-slate-300">{r.business_name} · {r.terminal_id}</div>
            <div className="text-xs text-slate-400">“{r.reason}” · requested {formatEAT(r.created_at)}</div>
            <div className="text-xs"><span className="rounded bg-slate-800 px-1.5 py-0.5">{r.status}</span> {r.admin_note && <span className="text-slate-400">· {r.admin_note}</span>}</div>
          </div>
          {(r.status === "REQUESTED" || r.status === "APPROVED") && (
            <ActionRow
              id={r.id}
              base="/api/admin/refunds"
              onDone={load}
              actions={
                r.status === "REQUESTED"
                  ? [{ label: "Approve", status: "APPROVED", tone: "bg-emerald-600 text-white" }, { label: "Reject", status: "REJECTED", needsNote: true, tone: "bg-rose-600 text-white" }]
                  : [{ label: "Mark refunded", status: "REFUNDED", tone: "bg-emerald-600 text-white" }, { label: "Reject", status: "REJECTED", needsNote: true, tone: "bg-rose-600 text-white" }]
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Kyc() {
  const { rows, error, load } = useList("/api/admin/kyc?status=SUBMITTED");
  if (!rows) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
      <p className="text-xs text-slate-500">Check the TIN and licence against the official registers before approving.</p>
      {rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">Nothing waiting for review.</p>}
      {rows.map((m) => (
        <div key={m.id} className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm md:grid-cols-[1fr_auto]">
          <div className="space-y-0.5">
            <div className="font-semibold">{m.business_name} <span className="text-xs font-normal text-slate-500">{m.terminal_id} · {m.category}</span></div>
            <div className="text-slate-300">Registered as: {m.legal_name}</div>
            <div className="font-mono text-xs text-slate-300">TIN {m.tin} · Licence {m.business_license}</div>
            <div className="text-xs text-slate-400">{m.address} · {m.phone}</div>
            <div className="text-xs text-slate-500">Submitted {m.kyc_submitted_at ? formatEAT(m.kyc_submitted_at) : "—"}</div>
          </div>
          <ActionRow id={m.id} base="/api/admin/kyc" onDone={load} actions={[{ label: "Verify", status: "VERIFIED", tone: "bg-emerald-600 text-white" }, { label: "Reject", status: "REJECTED", needsNote: true, tone: "bg-rose-600 text-white" }]} />
        </div>
      ))}
    </div>
  );
}

/**
 * Ride-hailing companies and their API keys. A company is registered here on its own: it is not a merchant and never appears in the merchant
 * list. A key is shown once (when made or rotated): copy it to the company straight away, because only its hash is kept.
 */
function RidePartners() {
  const { rows, error, load } = useList("/api/admin/ride-partners");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [shownKey, setShownKey] = useState<{ label: string; key: string } | null>(null);
  if (!rows) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;

  const call = async (method: "POST" | "PATCH", body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/ride-partners", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed");
      await load();
      return d as Row;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
      {msg && <p className={cn("rounded-lg p-3 text-sm", msg.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>{msg.text}</p>}
      {shownKey && (
        <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="font-semibold text-amber-200">API key for {shownKey.label} (shown once)</div>
          <code className="block break-all rounded bg-slate-950 p-2 text-xs text-slate-100">{shownKey.key}</code>
          <p className="text-xs text-amber-200/80">Copy it to the company now over a secure channel. It cannot be shown again; if it is lost, rotate it.</p>
          <button onClick={() => setShownKey(null)} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white">I have copied it</button>
        </div>
      )}
      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
        <div className="mb-2 text-sm font-semibold">Register a ride-hailing company</div>
        <p className="mb-3 text-xs text-slate-500">Register it only after checking its documents. It gets its own record for its rides; it is not added to the merchant list and nobody can sign in as it.</p>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name (for example Feres)" maxLength={80} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact person (optional)" maxLength={80} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Contact phone (optional)" maxLength={20} inputMode="tel" className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
          <button
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              const d = await call("POST", { name, contact_name: contact, contact_phone: phone });
              if (d?.api_key) {
                setShownKey({ label: String(d.name), key: String(d.api_key) });
                setName("");
                setContact("");
                setPhone("");
              }
            }}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-bold text-slate-950 disabled:opacity-40"
          >
            Register
          </button>
        </div>
      </div>
      {rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No companies yet.</p>}
      {rows.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
          <div className="space-y-0.5">
            <div className="font-semibold">{p.name} <span className={cn("ml-1 rounded px-1.5 py-0.5 text-xs", p.active ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400")}>{p.active ? "Active" : "Disabled"}</span></div>
            <div className="text-xs text-slate-400">
              {p.contact_name ? `${p.contact_name} · ` : ""}{p.contact_phone ? `${p.contact_phone} · ` : ""}key …{p.key_hint} · {p.last_used_at ? `last used ${formatEAT(p.last_used_at)}` : "never used"}
            </div>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => call("PATCH", { id: p.id, active: !p.active })} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{p.active ? "Disable" : "Enable"}</button>
            <button
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Rotate the key for ${p.name}? The current key stops working immediately.`)) return;
                const d = await call("PATCH", { id: p.id, rotate: true });
                if (d?.api_key) setShownKey({ label: p.name, key: String(d.api_key) });
              }}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Rotate key
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}