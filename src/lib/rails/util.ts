/** Breadth-first search for the first value stored under any of `keys`, up to `maxDepth` levels down. */
export function deepFind(obj: unknown, keys: string[], maxDepth = 5): unknown {
  let level: unknown[] = [obj];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        const rec = node as Record<string, unknown>;
        for (const k of keys) if (rec[k] !== undefined && rec[k] !== null && typeof rec[k] !== "object") return rec[k];
        next.push(...Object.values(rec));
      } else if (Array.isArray(node)) {
        next.push(...node);
      }
    }
    level = next;
  }
  return undefined;
}

export const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);

export const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Eastern Africa Time (UTC+3, no DST) wall-clock string `YYYY-MM-DDTHH:mm:ss`. */
export function eatLocalISO(d: Date): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 19);
}
