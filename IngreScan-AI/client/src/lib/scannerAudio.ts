/**
 * HTML5 Web Audio API & Haptics Engine for in-aisle grocery scanning.
 * - Pleasant two-tone chime for clean foods (Nutri-Score A/B, NOVA 1/2, zero allergens)
 * - Discordant warning buzz for high-risk additives, allergens, or ultra-processed foods
 * - Subtle viewfinder scan beep on barcode detection
 * - Native haptic vibration patterns (navigator.vibrate)
 * - Persisted user sound & haptic preferences with live mute toggle
 */

export type FeedbackType = "clean" | "warning" | "neutral";

export interface FoodEvaluation {
  type: FeedbackType;
  reasons: string[];
}

const STORAGE_KEY = "ingrescan_audio_muted";

let audioCtx: AudioContext | null = null;
const listeners = new Set<(muted: boolean) => void>();

/**
 * Returns whether sound and haptics are muted by the user.
 */
export function isAudioMuted(): boolean {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Update the user's mute preference.
 */
export function setAudioMuted(muted: boolean): void {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      localStorage.setItem(STORAGE_KEY, muted ? "true" : "false");
    } catch {
      // ignore
    }
  }
  listeners.forEach((fn) => fn(muted));
}

/**
 * Subscribe to mute state changes.
 */
export function subscribeAudioMute(fn: (muted: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Lazily initialize or resume the HTML5 AudioContext on user interaction.
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextClass =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!audioCtx) {
    try {
      audioCtx = new AudioContextClass();
    } catch {
      return null;
    }
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }

  return audioCtx;
}

/**
 * Trigger device haptic vibration pattern if supported.
 */
export function triggerHaptic(type: "clean" | "warning" | "scan"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (isAudioMuted()) return;

  try {
    if (type === "clean") {
      // Single crisp tactile affirmation
      navigator.vibrate([45]);
    } else if (type === "warning") {
      // Urgent double buzz pattern
      navigator.vibrate([90, 50, 160]);
    } else if (type === "scan") {
      // Subtle viewfinder capture pip
      navigator.vibrate([25]);
    }
  } catch {
    // ignore
  }
}

/**
 * Play a pleasant two-tone chime for clean foods.
 * Musical Interval: F5 (698.46 Hz) -> A5 (880.00 Hz) major third with warm harmonics.
 * Soft 15ms linear attack, smooth exponential decay, zero clicks.
 */
export function playCleanChime(): void {
  if (isAudioMuted()) return;
  triggerHaptic("clean");

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Master filter to remove any harsh high frequencies
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3200, now);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.3, now);
    masterGain.connect(ctx.destination);
    filter.connect(masterGain);

    // Tone 1: F5 (698.46 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(698.46, now);

    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.linearRampToValueAtTime(0.28, now + 0.015);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc1.connect(gain1);
    gain1.connect(filter);
    osc1.start(now);
    osc1.stop(now + 0.38);

    // Warm overtone for Tone 1 (subtle sparkle)
    const overtone1 = ctx.createOscillator();
    const overtoneGain1 = ctx.createGain();
    overtone1.type = "triangle";
    overtone1.frequency.setValueAtTime(1396.92, now); // Octave
    overtoneGain1.gain.setValueAtTime(0.0001, now);
    overtoneGain1.gain.linearRampToValueAtTime(0.06, now + 0.015);
    overtoneGain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    overtone1.connect(overtoneGain1);
    overtoneGain1.connect(filter);
    overtone1.start(now);
    overtone1.stop(now + 0.28);

    // Tone 2: A5 (880.00 Hz) - triggers 85ms after tone 1 for an uplifting musical chime
    const tone2Time = now + 0.085;
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(880.0, tone2Time);

    gain2.gain.setValueAtTime(0.0001, tone2Time);
    gain2.gain.linearRampToValueAtTime(0.32, tone2Time + 0.015);
    gain2.gain.exponentialRampToValueAtTime(0.0001, tone2Time + 0.45);

    osc2.connect(gain2);
    gain2.connect(filter);
    osc2.start(tone2Time);
    osc2.stop(tone2Time + 0.48);

    // Warm overtone for Tone 2
    const overtone2 = ctx.createOscillator();
    const overtoneGain2 = ctx.createGain();
    overtone2.type = "triangle";
    overtone2.frequency.setValueAtTime(1760.0, tone2Time);
    overtoneGain2.gain.setValueAtTime(0.0001, tone2Time);
    overtoneGain2.gain.linearRampToValueAtTime(0.08, tone2Time + 0.015);
    overtoneGain2.gain.exponentialRampToValueAtTime(0.0001, tone2Time + 0.35);
    overtone2.connect(overtoneGain2);
    overtoneGain2.connect(filter);
    overtone2.start(tone2Time);
    overtone2.stop(tone2Time + 0.38);
  } catch (err) {
    console.debug("[scannerAudio] Audio playback failed:", err);
  }
}

/**
 * Play a discordant warning buzz for high-risk additives or allergens.
 * Discordant Interval: Tritone clash (185.0 Hz F#3 and 261.63 Hz C4)
 * Filtered through a resonant lowpass filter with two authoritative alert pulses.
 */
export function playWarningBuzz(): void {
  if (isAudioMuted()) return;
  triggerHaptic("warning");

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Resonant lowpass filter to produce a punchy, hollow alert buzzer timbre
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(480, now);
    filter.Q.setValueAtTime(3.5, now);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.28, now);
    masterGain.connect(ctx.destination);
    filter.connect(masterGain);

    // Pulse 1: 0ms to 120ms
    const oscA1 = ctx.createOscillator();
    const oscB1 = ctx.createOscillator();
    const gainPulse1 = ctx.createGain();

    oscA1.type = "sawtooth";
    oscB1.type = "sawtooth";
    oscA1.frequency.setValueAtTime(185.0, now); // F#3
    oscB1.frequency.setValueAtTime(261.63, now); // C4 (diminished 5th / tritone dissonance)

    gainPulse1.gain.setValueAtTime(0.0001, now);
    gainPulse1.gain.linearRampToValueAtTime(0.25, now + 0.01);
    gainPulse1.gain.setValueAtTime(0.22, now + 0.1);
    gainPulse1.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    oscA1.connect(gainPulse1);
    oscB1.connect(gainPulse1);
    gainPulse1.connect(filter);

    oscA1.start(now);
    oscB1.start(now);
    oscA1.stop(now + 0.13);
    oscB1.stop(now + 0.13);

    // Pulse 2: 170ms to 330ms (second distinct buzz)
    const pulse2Time = now + 0.17;
    const oscA2 = ctx.createOscillator();
    const oscB2 = ctx.createOscillator();
    const gainPulse2 = ctx.createGain();

    oscA2.type = "sawtooth";
    oscB2.type = "sawtooth";
    oscA2.frequency.setValueAtTime(185.0, pulse2Time);
    oscB2.frequency.setValueAtTime(261.63, pulse2Time);

    gainPulse2.gain.setValueAtTime(0.0001, pulse2Time);
    gainPulse2.gain.linearRampToValueAtTime(0.26, pulse2Time + 0.01);
    gainPulse2.gain.setValueAtTime(0.22, pulse2Time + 0.14);
    gainPulse2.gain.exponentialRampToValueAtTime(0.0001, pulse2Time + 0.17);

    oscA2.connect(gainPulse2);
    oscB2.connect(gainPulse2);
    gainPulse2.connect(filter);

    oscA2.start(pulse2Time);
    oscB2.start(pulse2Time);
    oscA2.stop(pulse2Time + 0.18);
    oscB2.stop(pulse2Time + 0.18);
  } catch (err) {
    console.debug("[scannerAudio] Audio playback failed:", err);
  }
}

/**
 * Play a short subtle pip when the camera viewfinder acquires a barcode.
 */
export function playScanBeep(): void {
  if (isAudioMuted()) return;
  triggerHaptic("scan");

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1100, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  } catch (err) {
    // ignore
  }
}

/**
 * Evaluate food item for instant in-aisle audio & visual feedback.
 */
export function evaluateProductFeedback(product: {
  nutriscoreGrade?: string | null;
  novaGroup?: number | null;
  allergens?: string[] | null;
  ingredientsText?: string | null;
  overallRisk?: number | null;
}): FoodEvaluation {
  const allergens = (product.allergens ?? []).filter(Boolean);
  const hasAllergens = allergens.length > 0;
  const grade = product.nutriscoreGrade?.toLowerCase() ?? null;
  const nova = product.novaGroup ?? null;
  const risk = product.overallRisk ?? null;

  // 1. High-risk warning indicators
  const isHighRiskGrade = grade === "d" || grade === "e";
  const isUltraProcessed = nova === 4;
  const isHighRiskScore = risk !== null && risk >= 60;

  // Scan text for common dangerous additives if ingredients available
  const text = (product.ingredientsText ?? "").toLowerCase();
  const dangerousAdditives: string[] = [];
  if (/bha|bht|butylated/i.test(text)) dangerousAdditives.push("BHA/BHT");
  if (/potassium bromate/i.test(text)) dangerousAdditives.push("Potassium Bromate");
  if (/titanium dioxide|e171/i.test(text)) dangerousAdditives.push("Titanium Dioxide");
  if (/high fructose corn syrup/i.test(text)) dangerousAdditives.push("HFCS");
  if (/partially hydrogenated/i.test(text)) dangerousAdditives.push("Trans Fats");
  if (/aspartame|sucralose|acesulfame/i.test(text)) dangerousAdditives.push("Artificial Sweeteners");

  const hasDangerousAdditives = dangerousAdditives.length > 0;

  if (hasAllergens || isHighRiskGrade || isUltraProcessed || isHighRiskScore || hasDangerousAdditives) {
    const reasons: string[] = [];
    if (hasAllergens) {
      reasons.push(`Contains ${allergens.length} allergen(s): ${allergens.slice(0, 3).join(", ")}`);
    }
    if (hasDangerousAdditives) {
      reasons.push(`Contains high-risk additives: ${dangerousAdditives.join(", ")}`);
    }
    if (isHighRiskGrade) {
      reasons.push(`Poor nutritional rating (Nutri-Score ${grade?.toUpperCase()})`);
    }
    if (isUltraProcessed) {
      reasons.push("NOVA Group 4 (Ultra-Processed Food)");
    }
    if (isHighRiskScore) {
      reasons.push(`High chemical/ingredient risk score (${risk}/100)`);
    }

    return { type: "warning", reasons };
  }

  // 2. Clean food indicators
  const isCleanGrade = grade === "a" || grade === "b";
  const isUnprocessed = nova === 1 || nova === 2;
  const isLowRiskScore = risk !== null && risk <= 30;

  if (isCleanGrade || isUnprocessed || isLowRiskScore) {
    const reasons: string[] = [];
    if (isCleanGrade) {
      reasons.push(`High nutritional rating (Nutri-Score ${grade?.toUpperCase()})`);
    }
    if (isUnprocessed) {
      reasons.push(`Minimally processed (NOVA Group ${nova})`);
    }
    if (isLowRiskScore) {
      reasons.push(`Low chemical/additive risk (${risk}/100)`);
    }
    reasons.push("Zero declared allergens");

    return { type: "clean", reasons };
  }

  return { type: "neutral", reasons: [] };
}

/**
 * Automatically trigger the appropriate sound and haptic feedback for a product.
 * Returns the evaluation result.
 */
export function playFeedbackForProduct(product: {
  nutriscoreGrade?: string | null;
  novaGroup?: number | null;
  allergens?: string[] | null;
  ingredientsText?: string | null;
  overallRisk?: number | null;
}): FoodEvaluation {
  const result = evaluateProductFeedback(product);
  if (result.type === "clean") {
    playCleanChime();
  } else if (result.type === "warning") {
    playWarningBuzz();
  }
  return result;
}
