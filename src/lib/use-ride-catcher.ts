"use client";

import { useEffect, useState } from "react";
import { startLongPoll } from "@/lib/poll";

export interface CaughtRide {
  id: string;
  amount: number;
  currency: string;
  company: string;
  expires_at: string;
}

/**
 * How a driver's 2Pay app CATCHES a finished trip by itself. While the app is open and `enabled`, one request is held by the server
 * (the same held-request technique as the payment screen) and answered the moment a ride addressed to this driver exists, so the fare
 * appears about one network hop after the ride-hailing company closes the trip. Pauses while the app is in the background.
 */
export function useRideCatcher(enabled: boolean): { ride: CaughtRide | null; listening: boolean } {
  const [ride, setRide] = useState<CaughtRide | null>(null);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setListening(true);
    const stop = startLongPoll(async (sig, signal) => {
      const res = await fetch(`/api/driver/rides/next?${new URLSearchParams({ wait: "7", sig })}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setRide(d.ride ?? null);
      return res.headers.get("x-ride-sig") ?? "";
    });
    return () => {
      stop();
      setListening(false);
      setRide(null);
    };
  }, [enabled]);
  return { ride, listening };
}
