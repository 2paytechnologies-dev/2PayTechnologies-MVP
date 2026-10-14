/**
 * Polling that is kind to the phone: it runs one request at a time (a slow answer never piles up more behind it), it
 * pauses completely while the app or tab is in the background (no battery or data spent on a screen nobody is looking
 * at) and it catches up the instant the screen comes back.
 *
 * `intervalMs` may be a function so the pace can change (for example slower while the tab is hidden).
 * Returns a stop function.
 */
export function pollWhileVisible(run: () => Promise<void>, intervalMs: number | (() => number)): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const next = () => {
    if (stopped) return;
    const ms = typeof intervalMs === "function" ? intervalMs() : intervalMs;
    timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    if (stopped) return;
    if (typeof document !== "undefined" && document.hidden) return; // resumed by onVisible
    try {
      await run();
    } catch {
      /* a failed poll is retried on the next beat */
    }
    next();
  };
  const onVisible = () => {
    if (stopped || document.hidden) return;
    if (timer) clearTimeout(timer);
    void tick();
  };

  void tick();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * "Hold the line" polling: each request is answered by the server only when something changed (or after a few seconds),
 * and the next one is sent the moment it returns, so a change reaches the screen about one network hop after it happens.
 * `once(sig, signal)` makes one request and returns the new signature to send next time. The loop is paused while the app is
 * in the background (and the held request is released), failures back off for a moment, and the returned function stops it.
 */
export function startLongPoll(once: (sig: string, signal: AbortSignal) => Promise<string>): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;

  const onHidden = () => {
    if (document.hidden) ctrl?.abort(); // release the server connection while nobody is looking
  };
  document.addEventListener("visibilitychange", onHidden);

  void (async () => {
    let sig = "";
    while (!stopped) {
      if (document.hidden) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (!document.hidden || stopped) {
              document.removeEventListener("visibilitychange", wake);
              resolve();
            }
          };
          document.addEventListener("visibilitychange", wake);
        });
        sig = ""; // anything may have changed while away: ask for the current state straight away
        continue;
      }
      ctrl = new AbortController();
      try {
        sig = await once(sig, ctrl.signal);
      } catch {
        if (stopped) return;
        await sleep(document.hidden ? 0 : 1500);
      }
    }
  })();

  return () => {
    stopped = true;
    ctrl?.abort();
    document.removeEventListener("visibilitychange", onHidden);
  };
}