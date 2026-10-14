/**
 * Sale announcement: a short chime the moment a sale settles, then the word "Paid" ("ተከፍሏል" in Amharic).
 *
 * Browsers block audio until a user gesture, and the settlement arrives asynchronously, long after the last tap.
 * So the AudioContext is created and resumed on the cashier's FIRST touch (primeAudio), kept running while a sale
 * is waiting (keepAudioAlive), and reused for every later chime.
 */
import { getNative } from "@/lib/native";
import type { Lang } from "@/lib/i18n/core";

let ctx: AudioContext | null = null;

/**
 * The Amharic "ተከፍሏል" is a recording of a native Amharic speaker (public/sounds/paid-am.mp3), because phones have no Amharic voice to read it.
 * The bytes are fetched when the terminal opens and decoded as soon as the audio context exists.
 */
const CLIP_URL = "/sounds/paid-am.mp3?v=3";
let clipBytes: ArrayBuffer | null = null;
let clipBuffer: AudioBuffer | null = null;
let clipFetching = false;

function decodeClip() {
  if (!ctx || !clipBytes || clipBuffer) return;
  const bytes = clipBytes.slice(0); // decodeAudioData consumes its input
  ctx.decodeAudioData(bytes).then((b) => (clipBuffer = b)).catch(() => {});
}

/** Call when the terminal opens. Safe to call repeatedly. */
export function preloadAnnouncement() {
  try {
    if (clipBytes) return decodeClip();
    if (clipFetching || typeof window === "undefined") return;
    clipFetching = true;
    fetch(CLIP_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((b) => {
        clipBytes = b;
        decodeClip();
      })
      .catch(() => {})
      .finally(() => (clipFetching = false));
  } catch {
    /* the spelled-out fallback is used instead */
  }
}

/** Plays the recorded Amharic word through the page's audio. False when it is not ready (the caller falls back). */
function playClip(): boolean {
  if (!ctx || !clipBuffer) return false;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = clipBuffer;
    src.connect(ctx.destination);
    src.start();
    return true;
  } catch {
    return false;
  }
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctor) ctx = new Ctor();
  } catch {
    /* no audio on this device: the screen still confirms */
  }
  return ctx;
}

export function primeAudio() {
  try {
    if (!ensureCtx() || !ctx) return;
    preloadAnnouncement();
    if (ctx.state === "suspended") void ctx.resume();
    // A silent one-sample buffer fully unlocks output on iOS Safari.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* audio unavailable: the visual confirmation still shows */
  }
}

/** Phones suspend audio that has been idle; wake it while a sale is waiting so the chime is instant, not queued behind a resume. */
export function keepAudioAlive() {
  try {
    if (ctx && ctx.state !== "running") void ctx.resume();
  } catch {
    /* ignore */
  }
}

function tone() {
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const audio = ctx;
  [880, 1318.5].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const t = audio.currentTime + i * 0.14;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

/** The chime sounds the instant the payment clears; the spoken word follows this long after it starts (the chime itself lasts about half a second). */
export const VOICE_DELAY_MS = 1500;

/** What is said, and in which voice. */
export interface Utterance {
  text: string;
  /** Language of the voice that should read it. */
  voice: "en" | "am";
}

/**
 * The word for the sale: "Paid" (English voice) for English; for Amharic the recorded clip of "ተከፍሏል" (see above).
 * Only if that clip cannot be played does Amharic fall back to a voice: a real Amharic voice, or the phone's English
 * voice reading the word spelled the way it is pronounced (never the English word "Paid").
 */
export const AMHARIC_SCRIPT = "ተከፍሏል";
export const AMHARIC_SPELLED = "Teke filwal";

export function utteranceFor(lang: Lang, haveAmharicVoice: boolean): Utterance {
  if (lang === "en") return { text: "Paid", voice: "en" };
  return haveAmharicVoice ? { text: AMHARIC_SCRIPT, voice: "am" } : { text: AMHARIC_SPELLED, voice: "en" };
}

/** Browser: the recorded clip for Amharic, speech for English (and the last-resort fallback for Amharic). */
function speakInBrowser(lang: Lang) {
  try {
    if (lang === "am" && playClip()) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    const voices = synth.getVoices();
    const find = (tag: string) => voices.find((v) => v.lang.toLowerCase().startsWith(tag));
    const u0 = utteranceFor(lang, !!find("am"));
    const voice = find(u0.voice);
    const u = new SpeechSynthesisUtterance(u0.text);
    u.volume = 1;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = u0.voice;
    }
    synth.cancel();
    synth.speak(u);
  } catch {
    /* speech unavailable */
  }
}

/**
 * The Android app (its WebView has no speechSynthesis). Amharic: the app plays the recorded clip itself (2.1.7+), else the
 * page plays it, else the phone's voice. English: the phone's English voice says "Paid".
 */
function speakInApp(lang: Lang) {
  try {
    const native = getNative();
    if (!native) return;
    if (lang === "am") {
      if (typeof native.playPaidAmharic === "function" && native.playPaidAmharic()) return;
      if (playClip()) return;
    }
    const haveAm = typeof native.canSpeak === "function" ? native.canSpeak("am") : true;
    const u = utteranceFor(lang, haveAm);
    native.speak(u.text, u.voice);
  } catch {
    /* ignore */
  }
}

/** Chime now; the spoken word VOICE_DELAY_MS later. */
export function playSettlementChime(lang: Lang = "en") {
  try {
    const native = getNative();
    // The app plays the chime itself (newer builds); the page's own audio is the fallback for browsers and older apps.
    if (native && typeof native.chime === "function") native.chime();
    else tone();
    if (native) native.vibrate(250);
    setTimeout(() => (native ? speakInApp(lang) : speakInBrowser(lang)), VOICE_DELAY_MS);
  } catch {
    /* ignore */
  }
}
/**
 * The customer's phone: sound the chime and the spoken word when THEIR receipt is on screen. A browser only allows sound
 * after the person has touched the page; a customer coming back from their bank app has not, so if sound is blocked it starts
 * at their first touch (within 30 seconds) rather than staying silent for good. On the merchant's screens (where the first touch
 * on the app already happened) use playSettlementChime directly.
 */
export function announceWhenAllowed(lang: Lang) {
  const c = ensureCtx();
  if (!c) return void playSettlementChime(lang);
  preloadAnnouncement();
  void c.resume().catch(() => {});
  setTimeout(() => {
    if (c.state === "running") return playSettlementChime(lang);
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const fire = () => {
      events.forEach((e) => window.removeEventListener(e, fire));
      primeAudio();
      playSettlementChime(lang);
    };
    events.forEach((e) => window.addEventListener(e, fire, { once: true, passive: true }));
    setTimeout(() => events.forEach((e) => window.removeEventListener(e, fire)), 30_000);
  }, 150);
}