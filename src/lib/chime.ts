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

const WORD = { en: { text: "Paid", tag: "en" }, am: { text: "ተከፍሏል", tag: "am" } } as const;

/** Browser speech. Falls back to English "Paid" when the device has no Amharic voice, so there is always a voice. */
function speakInBrowser(lang: Lang) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const voices = synth.getVoices();
    const find = (tag: string) => voices.find((v) => v.lang.toLowerCase().startsWith(tag));
    const wanted = WORD[lang];
    const voice = find(wanted.tag);
    const use = voice ? { word: wanted, voice } : { word: WORD.en, voice: find("en") };
    const u = new SpeechSynthesisUtterance(use.word.text);
    if (use.voice) {
      u.voice = use.voice;
      u.lang = use.voice.lang;
    } else {
      u.lang = use.word.tag;
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
    const haveVoice = typeof native.canSpeak === "function" ? native.canSpeak(WORD[lang].tag) : true;
    const w = haveVoice ? WORD[lang] : WORD.en;
    native.speak(w.text, w.tag);
  } catch {
    /* ignore */
  }
}

/** Chime now, the spoken word right after it (the chime lasts about half a second). */
export function playSettlementChime(lang: Lang = "en") {
  try {
    tone();
    const native = getNative();
    if (native) native.vibrate(250);
    setTimeout(() => (native ? speakInApp(lang) : speakInBrowser(lang)), 450);
  } catch {
    /* ignore */
  }
}
