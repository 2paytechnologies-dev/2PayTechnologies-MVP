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
});
