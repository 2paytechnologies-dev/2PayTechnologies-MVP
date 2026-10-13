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

export function primeAudio() {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
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
 * The word for the sale: "Paid" for English, "ተከፍሏል" for Amharic. A phone without an Amharic voice cannot read the
 * Ethiopic script, so its English voice is given the same word spelled the way it is pronounced, so the merchant still
 * hears Amharic, not English. (Change AMHARIC_SPELLED if a different spelling sounds closer on the phones you use.)
 */
export const AMHARIC_SCRIPT = "ተከፍሏል";
export const AMHARIC_SPELLED = "Teke filwal";

export function utteranceFor(lang: Lang, haveAmharicVoice: boolean): Utterance {
  if (lang === "en") return { text: "Paid", voice: "en" };
  return haveAmharicVoice ? { text: AMHARIC_SCRIPT, voice: "am" } : { text: AMHARIC_SPELLED, voice: "en" };
}

/** Browser speech. */
function speakInBrowser(lang: Lang) {
  try {
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

/** The Android app speaks natively (its WebView has no speechSynthesis). Older apps lack canSpeak and just try. */
function speakInApp(lang: Lang) {
  try {
    const native = getNative();
    if (!native) return;
    const haveAm = typeof native.canSpeak === "function" ? native.canSpeak("am") : true;
    const u = utteranceFor(lang, haveAm);
    native.speak(u.text, u.voice);
  } catch {
    /* ignore */
  }
}

/** Whether this device has a real Amharic voice (otherwise the English voice reads the spelled-out word). */
export function hasVoiceFor(lang: Lang): boolean {
  try {
    if (lang === "en") return true;
    const native = getNative();
    if (native) return typeof native.canSpeak === "function" ? native.canSpeak("am") : true;
    return !!window.speechSynthesis?.getVoices().some((v) => v.lang.toLowerCase().startsWith("am"));
  } catch {
    return false;
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