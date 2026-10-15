"use client";

import { useEffect, useMemo, useState } from "react";
import { Car, Nfc, QrCode, Smartphone } from "lucide-react";
import { LATENCY_TARGET_S } from "@/lib/constants";
import { fmt } from "@/lib/format";
import { isPaid, type Merchant, type Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Network {
  merchants: number;
  shop_qr_stands: number;
  app_devices: number;
  app_devices_by_role: { WAITER: number; CASHIER: number; MANAGER: number };
  ride_partners: number | null;
  ride_drivers_24h: number;
  ride_checkouts_24h: number;
  ride_available: boolean;
}

const CHANNELS = [
  { id: "TERMINAL", label: "Cashier terminals", note: "Tap or QR from the 2Pay terminal (app or browser)", icon: Nfc },
  { id: "RIDE", label: "Ride-hailing software nodes", note: "The driver's phone acts as the NFC tag, started by a partner app", icon: Car },
  { id: "STATIC_QR", label: "Passive shop stands", note: "Printed shop QR: the customer scans, no device of ours is involved", icon: QrCode },
] as const;

/**
 * Network telemetry by channel: how many sales, how much value and how fast each kind of node did today, and how many of each
 * kind exist. "Software nodes" are phones running 2Pay (cashier terminals and ride-hailing drivers); "passive stands" are printed QR codes.
 * Sales carry the channel they started on, but not whether a browser or the app was used, so the terminal row covers both.
 */
export function NetworkNodes({ txs, merchants }: { txs: Transaction[]; merchants: Merchant[] }) {
  const [net, setNet] = useState<Network | null>(null);
  useEffect(() => {
    let off = false;
    const load = () =>
      fetch("/api/admin/network", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !off && d && setNet(d))
        .catch(() => {});
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, []);

  const rows = useMemo(() => {
    const paid = txs.filter((t) => isPaid(t.status));
    const total = paid.reduce((s, t) => s + Number(t.amount), 0);
    return CHANNELS.map((c) => {
      const mine = paid.filter((t) => (t.source ?? "TERMINAL") === c.id);
      const lats = mine.map((t) => t.latency_ms).filter((l): l is number => l != null);
      const gmv = mine.reduce((s, t) => s + Number(t.amount), 0);
      return { ...c, taps: mine.length, gmv, share: total ? (gmv / total) * 100 : 0, nodes: new Set(mine.map((t) => t.merchant_id)).size, latency: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length / 1000 : null };
    });
  }, [txs]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <Smartphone className="h-5 w-5 text-brand" /> Network &amp; node management
      </h2>
      <p className="mb-4 text-xs text-slate-500">Today (EAT), by how the payment started. {merchants.length} businesses on the network.</p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Channel", "Active nodes today", "Settled taps", "Volume (ETB)", "Share", `Avg latency (target < ${LATENCY_TARGET_S.toFixed(1)}s)`].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, label, note, icon: Icon, taps, gmv, share, nodes, latency }) => (
              <tr key={id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4 text-brand" /> {label}</div>
                  <div className="text-xs text-slate-500">{note}</div>
                </td>
                <td className="px-3 py-3 tabular-nums">{nodes}</td>
                <td className="px-3 py-3 tabular-nums">{taps}</td>
                <td className="px-3 py-3 tabular-nums">{fmt(gmv)}</td>
                <td className="px-3 py-3 tabular-nums text-slate-300">{share.toFixed(0)}%</td>
                <td className={cn("px-3 py-3 tabular-nums", latency == null ? "text-slate-500" : latency < LATENCY_TARGET_S ? "text-emerald-400" : "text-rose-400")}>{latency == null ? "—" : `${latency.toFixed(2)}s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Businesses" value={net?.merchants} />
        <Stat label="Shop-QR stands enabled" value={net?.shop_qr_stands} />
        <Stat label="Phones bound to the 2Pay app" value={net?.app_devices} sub={net ? `${net.app_devices_by_role.WAITER} waiters · ${net.app_devices_by_role.CASHIER} cashiers · ${net.app_devices_by_role.MANAGER} managers` : undefined} />
        <Stat label="Ride partners (active)" value={net?.ride_partners ?? undefined} />
        <Stat label="Drivers, last 24 h" value={net?.ride_available ? net.ride_drivers_24h : undefined} />
        <Stat label="Ride checkouts, 24 h" value={net?.ride_available ? net.ride_checkouts_24h : undefined} />
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | undefined; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value ?? "—"}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
