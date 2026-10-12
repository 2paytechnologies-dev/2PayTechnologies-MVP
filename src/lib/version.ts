/** Dotted-version comparison for the app's update prompt ("2.1.0" vs "2.0.0"). Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface LatestApp {
  version: string;
  /** Oldest app version still allowed to take payments. Older ones are told to update. */
  minVersion: string;
  apk: string;
  notes?: string;
}

export type UpdateState = "current" | "available" | "required";

export function updateState(installed: string, latest: LatestApp): UpdateState {
  if (compareVersions(installed, latest.minVersion) < 0) return "required";
  if (compareVersions(installed, latest.version) < 0) return "available";
  return "current";
}
