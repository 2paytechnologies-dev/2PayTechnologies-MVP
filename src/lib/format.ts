export const EAT_TZ = "Africa/Addis_Ababa";

export const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "10 Oct 2026, 14:32 EAT" */
export function formatEAT(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { timeZone: EAT_TZ, day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: EAT_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time} EAT`;
}

/** Calendar date (YYYY-MM-DD) of an instant, in Addis Ababa. */
export function eatDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: EAT_TZ });
}

/** Ethiopia is UTC+3 year-round (no DST), so a local-midnight ISO instant is exact. */
export function eatDayStartISO(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00+03:00`).toISOString();
}

/** Exclusive end of an EAT calendar day. */
export function eatDayEndISO(dateKey: string): string {
  return new Date(new Date(`${dateKey}T00:00:00+03:00`).getTime() + 86_400_000).toISOString();
}

/** Human-friendly reference derived from the transaction id, e.g. 2P-3F9A1C07. */
export function referenceFor(transactionId: string): string {
  return `2P-${transactionId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** RFC 4180 CSV with spreadsheet formula-injection neutralisation and a UTF-8 BOM for Excel. */
export function toCSV(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
