/**
 * The Android app injects `window.TwoPayNative` (see android/.../NativeBridge.kt). In a normal browser it is
 * absent and everything here is a no-op, so the same web code runs in both places.
 */
export type NfcState = "READY" | "DISABLED" | "UNSUPPORTED";

export interface NativeInfo {
  native: true;
  version: string;
  nfc: NfcState;
  hce: boolean;
}

interface Bridge {
  info(): string;
  setPayUrl(url: string): boolean;
  clearPayUrl(): void;
  keepAwake(on: boolean): void;
  openNfcSettings(): void;
  saveFile(name: string, mime: string, base64: string): string;
  speak(text: string, lang: string): void;
  canSpeak?(lang: string): boolean; // added in 2.1.4: false when the phone has no voice for that language
  vibrate(ms: number): void;
  reload(): void;
  print?(): void; // added in 2.1.0; older apps simply do not have it
}

declare global {
  interface Window {
    TwoPayNative?: Bridge;
  }
}

export const getNative = (): Bridge | null => (typeof window !== "undefined" ? (window.TwoPayNative ?? null) : null);

export function nativeInfo(): NativeInfo | null {
  try {
    const n = getNative();
    return n ? (JSON.parse(n.info()) as NativeInfo) : null;
  } catch {
    return null;
  }
}

/** Present a pay link to phones that tap this one. Returns false when not running in the app or the link was refused. */
export function presentPayLink(url: string): boolean {
  try {
    return getNative()?.setPayUrl(url) ?? false;
  } catch {
    return false;
  }
}

export function clearPayLink() {
  try {
    getNative()?.clearPayUrl();
  } catch {
    /* ignore */
  }
}

export function keepScreenAwake(on: boolean) {
  try {
    getNative()?.keepAwake(on);
  } catch {
    /* ignore */
  }
}

/** Print the page (posters, reports). The Android WebView can't open the print dialog by itself, so the app does it. */
export function printPage() {
  try {
    const n = getNative();
    if (n?.print) return n.print();
  } catch {
    /* fall through to the browser */
  }
  window.print();
}