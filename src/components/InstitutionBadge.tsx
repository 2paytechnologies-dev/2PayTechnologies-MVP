import { hueFor, shortName } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** A round coloured badge with the institution's abbreviation (no logos needed, and each bank keeps its own colour). */
export function InstitutionBadge({ name, className }: { name: string; className?: string }) {
  const hue = hueFor(name);
  return (
    <span
      aria-hidden
      className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white", className)}
      style={{ background: `hsl(${hue} 55% 38%)` }}
    >
      {shortName(name)}
    </span>
  );
}
