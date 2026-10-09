/**
 * Settlement chime. Browsers block audio until a user gesture, and the settlement event arrives
 * asynchronously (Realtime), long after the last tap. So the AudioContext is created and resumed
 * on the cashier's FIRST touch (primeAudio) and reused for every later chime.
 */
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

/** Spoken "ተከፍሏል" ("it has been paid") when the device has an Amharic voice; otherwise the tone alone. */
function speakAmharic(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("am"));
    if (!voice) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    synth.speak(u);
  } catch {
    /* speech unavailable */
  }
}

export function playSettlementChime(text = "ተከፍሏል") {
  try {
    tone();
    setTimeout(() => speakAmharic(text), 450);
  } catch {
    /* ignore */
  }
}
