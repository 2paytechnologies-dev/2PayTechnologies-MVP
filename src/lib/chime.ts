/**
 * Sale announcement: a short chime the moment the payment clears, and the word "Paid" ("ተከፍሏል" in Amharic) with the receipt, which
 * starts the instant the chime ends so the two never overlap and the voice is never late.
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

/** Speech engines start slowly the first time (voices load, the engine spins up). Do that on the first touch, so "Paid" is instant later. */
let voiceCache: SpeechSynthesisVoice[] = [];
let speechWarm = false;
function warmSpeech() {
  try {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return;
    voiceCache = synth.getVoices();
    synth.addEventListener?.("voiceschanged", () => (voiceCache = synth.getVoices()));
    if (speechWarm) return;
    speechWarm = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch {
    /* speech unavailable */
  }
}

export function primeAudio() {
  try {
    warmSpeech();
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

/** The chime lasts about half a second (two soft tones). The spoken word starts the moment it ends: no gap, no overlap. */
export const CHIME_MS = 550;
export const VOICE_DELAY_MS = CHIME_MS;

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
    const voices = synth.getVoices().length ? synth.getVoices() : voiceCache;
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

/** The chime: attached to the payment itself, so it sounds the moment the payment clears. */
export function playPaymentChime() {
  try {
    const native = getNative();
    // The app plays the chime itself (newer builds); the page's own audio is the fallback for browsers and older apps.
    if (native && typeof native.chime === "function") native.chime();
    else tone();
    if (native) native.vibrate(250);
  } catch {
    /* ignore */
  }
}

/** The spoken word: attached to the receipt, so it sounds when the receipt is on screen. */
export function playReceiptVoice(lang: Lang = "en") {
  try {
    if (getNative()) speakInApp(lang);
    else speakInBrowser(lang);
  } catch {
    /* ignore */
  }
}

/** Chime now; the spoken word when the chime ends. For screens where the payment and its receipt appear together (the merchant's). */
export function playSettlementChime(lang: Lang = "en") {
  playPaymentChime();
  setTimeout(() => playReceiptVoice(lang), VOICE_DELAY_MS);
}

// The customer's phone plays the chime when the payment clears (on the pay page) and the word with the receipt (on the next page).
// This remembers, for this payment on this phone, that the chime has already sounded, so the receipt only adds the word.
const chimedKey = (token: string) => `2pay:chimed:${token}`;
export function markChimed(token: string) {
  try {
    sessionStorage.setItem(chimedKey(token), "1");
  } catch {
    /* ignore */
  }
}
export function wasChimed(token: string): boolean {
  try {
    return sessionStorage.getItem(chimedKey(token)) === "1";
  } catch {
    return false;
  }
}
/**
 * Run `play` as soon as the browser allows sound. A browser only allows sound after the person has touched the page; a customer
 * coming back from their bank app has not, so if sound is blocked it starts at their first touch (within 30 seconds) instead of
 * staying silent for good. Nothing waits when sound is already allowed.
 */
function whenAudioAllowed(play: () => void) {
  const c = ensureCtx();
  if (!c) return void play();
  preloadAnnouncement();
  if (c.state === "running") return void play();
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    play();
  };
  const waitForTouch = () => {
    if (done) return;
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    const onTouch = () => {
      events.forEach((e) => window.removeEventListener(e, onTouch));
      primeAudio();
      fire();
    };
    events.forEach((e) => window.addEventListener(e, onTouch, { once: true, passive: true }));
    setTimeout(() => events.forEach((e) => window.removeEventListener(e, onTouch)), 30_000);
  };
  // resume() answers within a few milliseconds when allowed; with no touch yet it may never answer, so do not wait for it.
  c.resume().then(() => (c.state === "running" ? fire() : waitForTouch()), waitForTouch);
  setTimeout(() => {
    if (!done && c.state !== "running") waitForTouch();
  }, 80);
}

/** The customer's receipt: chime and word together (the chime first), as soon as sound is allowed. */
export function announceWhenAllowed(lang: Lang) {
  whenAudioAllowed(() => playSettlementChime(lang));
}

/** The customer's receipt after the chime already sounded when the payment cleared: just the word, as soon as sound is allowed. */
export function receiptVoiceWhenAllowed(lang: Lang) {
  whenAudioAllowed(() => playReceiptVoice(lang));
}