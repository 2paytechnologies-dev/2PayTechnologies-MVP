"use client";

import { useState } from "react";
import { InstitutionBadge } from "@/components/InstitutionBadge";
import { getRailLogo } from "@/lib/rail-logos";
import { cn } from "@/lib/utils";

/**
 * A bank or wallet's logo when one is available (see lib/rail-logos.ts), on a clean white tile so every brand reads clearly on
 * the dark page; otherwise the styled initials badge. A logo that fails to load falls back to the badge too.
 */
export function BrandLogo({ name, className }: { name: string; className?: string }) {
  const src = getRailLogo(name);
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <InstitutionBadge name={name} className={className} />;
  return (
    <span aria-hidden className={cn("flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain" />
    </span>
  );
}
