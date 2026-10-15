import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { CSV_HEADER, saleCsvRow, shapeSale } from "@/lib/compliance-sales";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 1000;
/** A hard ceiling per export, so one request cannot read the whole ledger. Export a shorter range for more. */
const MAX_ROWS = 100_000;
const MAX_RANGE_DAYS = 92;

/**
 * The paid-sales evidence for a date range as a CSV file for an auditor: GET ?from=2026-10-01&to=2026-10-31. It is read in pages and
 * streamed, so memory stays small however many sales there are. Same columns and masking as the screen; the export is audit-logged.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const q = new URL(req.url).searchParams;
  const from = Date.parse(q.get("from") ?? "");
  const to = Date.parse(q.get("to") ?? "");
  const json = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return json("from and to (dates) are required, and to must be after from", 400);
  if (to - from > MAX_RANGE_DAYS * 86_400_000) return json(`Export at most ${MAX_RANGE_DAYS} days at a time`, 400);
  const search = (q.get("q") ?? "").trim().slice(0, 60);

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return json("Server misconfigured", 500);
    throw e;
  }
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to + 86_400_000).toISOString(); // `to` is the last day, inclusive
  await audit(admin, guard.session, req, { action: "compliance.export", targetType: "report", details: { from: fromIso, to: toIso, q: search } });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("﻿" + CSV_HEADER.join(",") + "\r\n"));
      let before: string | null = null;
      let beforeId: string | null = null;
      let sent = 0;
      try {
        while (sent < MAX_ROWS) {
          const { data, error } = await admin.rpc("admin_find_sales", { p_q: search, p_from: fromIso, p_to: toIso, p_limit: PAGE, p_before: before, p_before_id: beforeId });
          if (error) throw new Error(error.message);
          const rows = (data ?? []) as Record<string, unknown>[];
          if (!rows.length) break;
          controller.enqueue(encoder.encode(rows.map((r) => saleCsvRow(shapeSale(r))).join("\r\n") + "\r\n"));
          sent += rows.length;
          if (rows.length < PAGE) break;
          const last = rows[rows.length - 1];
          before = last.created_at as string;
          beforeId = last.id as string;
        }
        if (sent >= MAX_ROWS) controller.enqueue(encoder.encode(`# stopped at ${MAX_ROWS} rows: export a shorter range for the rest\r\n`));
        controller.close();
      } catch (e) {
        console.error("[compliance export]", (e as Error).message);
        controller.enqueue(encoder.encode("# the export stopped early because of an error: run it again\r\n"));
        controller.close();
      }
    },
  });
  const name = `2pay-sales-evidence-${new Date(from).toISOString().slice(0, 10)}_${new Date(to).toISOString().slice(0, 10)}.csv`;
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
