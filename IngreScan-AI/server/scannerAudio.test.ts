import { describe, expect, it, vi } from "vitest";
import {
  evaluateProductFeedback,
  isAudioMuted,
  setAudioMuted,
  subscribeAudioMute,
  playCleanChime,
  playWarningBuzz,
  playScanBeep,
  playFeedbackForProduct,
} from "../client/src/lib/scannerAudio";

describe("HTML5 Scanner Audio & Haptics Engine", () => {
  describe("evaluateProductFeedback", () => {
    it("classifies clean foods with Nutri-Score A and NOVA 1 without allergens as clean", () => {
      const res = evaluateProductFeedback({
        nutriscoreGrade: "a",
        novaGroup: 1,
        allergens: [],
      });
      expect(res.type).toBe("clean");
      expect(res.reasons.some((r) => r.includes("Nutri-Score A"))).toBe(true);
      expect(res.reasons.some((r) => r.includes("Zero declared allergens"))).toBe(true);
    });

    it("classifies Nutri-Score B as clean", () => {
      const res = evaluateProductFeedback({
        nutriscoreGrade: "b",
        allergens: [],
      });
      expect(res.type).toBe("clean");
    });

    it("triggers warning buzz for products with declared allergens", () => {
      const res = evaluateProductFeedback({
        nutriscoreGrade: "a",
        novaGroup: 1,
        allergens: ["peanuts", "tree nuts"],
      });
      expect(res.type).toBe("warning");
      expect(res.reasons.some((r) => r.includes("Contains 2 allergen(s)"))).toBe(true);
    });

    it("triggers warning buzz for poor Nutri-Score (D / E)", () => {
      const resE = evaluateProductFeedback({
        nutriscoreGrade: "e",
      });
      expect(resE.type).toBe("warning");
      expect(resE.reasons.some((r) => r.includes("Nutri-Score E"))).toBe(true);

      const resD = evaluateProductFeedback({
        nutriscoreGrade: "d",
      });
      expect(resD.type).toBe("warning");
    });

    it("triggers warning buzz for NOVA Group 4 (Ultra-processed)", () => {
      const res = evaluateProductFeedback({
        nutriscoreGrade: "c",
        novaGroup: 4,
      });
      expect(res.type).toBe("warning");
      expect(res.reasons.some((r) => r.includes("NOVA Group 4"))).toBe(true);
    });

    it("triggers warning buzz for high-risk additives (BHA, Potassium Bromate, Titanium Dioxide)", () => {
      const res = evaluateProductFeedback({
        ingredientsText: "Wheat flour, palm oil, butylated hydroxytoluene (BHT), artificial flavor",
      });
      expect(res.type).toBe("warning");
      expect(res.reasons.some((r) => r.includes("BHA/BHT"))).toBe(true);
    });

    it("triggers warning buzz for high overall risk score (>= 60)", () => {
      const res = evaluateProductFeedback({
        overallRisk: 75,
      });
      expect(res.type).toBe("warning");
      expect(res.reasons.some((r) => r.includes("75/100"))).toBe(true);
    });

    it("returns neutral when no indicators are present", () => {
      const res = evaluateProductFeedback({});
      expect(res.type).toBe("neutral");
      expect(res.reasons).toEqual([]);
    });
  });

  describe("playFeedbackForProduct helper", () => {
    it("returns evaluation and runs without throwing in Node environment", () => {
      const cleanResult = playFeedbackForProduct({
        nutriscoreGrade: "a",
        novaGroup: 1,
      });
      expect(cleanResult.type).toBe("clean");

      const warnResult = playFeedbackForProduct({
        nutriscoreGrade: "e",
        allergens: ["milk"],
      });
      expect(warnResult.type).toBe("warning");
    });
  });

  describe("Audio context resilience", () => {
    it("safe to call playCleanChime, playWarningBuzz, and playScanBeep when AudioContext is absent", () => {
      expect(() => playCleanChime()).not.toThrow();
      expect(() => playWarningBuzz()).not.toThrow();
      expect(() => playScanBeep()).not.toThrow();
    });
  });

  describe("Mute preference management", () => {
    it("supports subscribing to mute state changes", () => {
      const spy = vi.fn();
      const unsub = subscribeAudioMute(spy);

      setAudioMuted(true);
      expect(spy).toHaveBeenCalledWith(true);

      setAudioMuted(false);
      expect(spy).toHaveBeenCalledWith(false);

      unsub();
      setAudioMuted(true);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
