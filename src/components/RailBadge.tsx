import { isBank, isWallet } from "@/lib/constants";
import type { Rail, Status } from "@/lib/types";

const statusStyle: Record<Status, string> = {
  PENDING: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  SUCCESS: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  SETTLED: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  FAILED: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset";

/** Banks are sky, wallets amber; anything else (legacy rails such as "EthioPay-IPS") is neutral. */
function railStyle(rail: Rail): string {
  if (isBank(rail)) return "bg-sky-500/15 text-sky-300 ring-sky-500/30";
  if (isWallet(rail)) return "bg-amber-500/15 text-amber-300 ring-amber-500/30";
  return "bg-slate-500/15 text-slate-300 ring-slate-500/30";
}

export function RailBadge({ rail }: { rail: Rail }) {
  return <span className={`${base} ${railStyle(rail)}`}>{rail}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`${base} ${statusStyle[status]}`}>{status}</span>;
}
