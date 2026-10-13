import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AMHARIC_SCRIPT, AMHARIC_SPELLED, VOICE_DELAY_MS, utteranceFor } from "@/lib/chime";

describe("payment announcement", () => {
  it("English interface says Paid in the English voice", () => {
    expect(utteranceFor("en", true)).toEqual({ text: "Paid", voice: "en" });
    expect(utteranceFor("en", false)).toEqual({ text: "Paid", voice: "en" });
  });

  it("Amharic interface says ተከፍሏል with a real Amharic voice", () => {
    expect(utteranceFor("am", true)).toEqual({ text: AMHARIC_SCRIPT, voice: "am" });
    expect(AMHARIC_SCRIPT).toBe("ተከፍሏል");
  });

  it("Amharic interface never falls back to the English word 'Paid'", () => {
    const u = utteranceFor("am", false);
    expect(u.text).toBe(AMHARIC_SPELLED);
    expect(u.text).not.toMatch(/paid/i);
    expect(u.voice).toBe("en"); // the phone's English voice reads the spelled-out Amharic word
  });

  it("the word follows the chime by 1 to 1.5 seconds", () => {
    expect(VOICE_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(VOICE_DELAY_MS).toBeLessThanOrEqual(1500);
  });

  it("the recorded Amharic word ships with both the website and the Android app", () => {
    for (const file of ["public/sounds/paid-am.mp3", "android/app/src/main/res/raw/paid_am.mp3"]) {
      expect(existsSync(file), file).toBe(true);
      const size = statSync(file).size;
      expect(size).toBeGreaterThan(2_000);
      expect(size).toBeLessThan(100_000);
      const head = readFileSync(file).subarray(0, 3);
      const looksLikeMp3 = (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33); // frame sync or "ID3"
      expect(looksLikeMp3, file).toBe(true);
    }
  });
});