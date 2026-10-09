import type { Rail, Status } from "@/lib/types";

const railStyle: Record<Rail, string> = {
  "EthioPay-IPS": "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  Telebirr: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "CBE Birr": "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
};

const statusStyle: Record<Status, string> = {
  PENDING: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  SUCCESS: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  SETTLED: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  FAILED: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset";

export function RailBadge({ rail }: { rail: Rail }) {
  return <span className={`${base} ${railStyle[rail]}`}>{rail}</span>;
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`${base} ${statusStyle[status]}`}>{status}</span>;
}
