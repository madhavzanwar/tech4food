/** Pure command parser. No I/O. */

export type Command =
  | { type: "help" }
  | { type: "link"; code: string | null }
  | { type: "fridge"; page: number }
  | { type: "more" }
  | { type: "rescue" }
  | { type: "clear"; name: string | null }
  | { type: "add" }
  | { type: "stop" }
  | { type: "start" }
  | { type: "remind"; hour: number | null; raw: string }
  | { type: "tz"; zone: string | null }
  | { type: "cancel" }
  | { type: "choice"; n: number }
  | { type: "barcode"; digits: string }
  | { type: "digits"; digits: string }
  | { type: "ingredients"; text: string }
  | { type: "empty" }
  | { type: "unknown"; text: string };

export const MAX_INGREDIENT_TEXT = 4000;

const TRAILING_PUNCT = /[\s.!?,;:]+$/;

/** Strip control/zero-width characters and collapse whitespace. */
export function cleanInput(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠﻿]/g, "")
    .replace(/[ \t ]+/g, " ")
    .trim();
}

export function parseRemindHour(arg: string): number | null {
  const m = /^(\d{1,2})(?::00)?\s*(am|pm)?$/i.exec(arg.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[2]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  }
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

export function parseCommand(input: string | undefined | null): Command {
  const cleaned = cleanInput(input ?? "");
  if (!cleaned) return { type: "empty" };

  const stripped = cleaned.replace(TRAILING_PUNCT, "");
  if (cleaned === "?" ) return { type: "help" };
  if (!stripped) return { type: "unknown", text: cleaned };

  // Pure digits: numbered choice (1-2 digits), barcode (8-14), or something else.
  if (/^\d+$/.test(stripped)) {
    if (stripped.length <= 2) return { type: "choice", n: Number(stripped) };
    if (stripped.length >= 8 && stripped.length <= 14) return { type: "barcode", digits: stripped };
    return { type: "digits", digits: stripped };
  }
  // Barcode typed with spaces or dashes, e.g. "5 449000 000996".
  const compact = stripped.replace(/[\s-]/g, "");
  if (/^\d{8,14}$/.test(compact) && /^[\d\s-]+$/.test(stripped)) return { type: "barcode", digits: compact };

  // Any whitespace (including a line break, which cleanInput keeps) separates the command word from its argument.
  const sp = stripped.search(/\s/);
  const word = (sp === -1 ? stripped : stripped.slice(0, sp)).toUpperCase();
  const arg = sp === -1 ? "" : stripped.slice(sp + 1).trim();

  switch (word) {
    case "HELP":
    case "HI":
    case "HELLO":
    case "HEY":
    case "MENU":
    case "COMMANDS":
      return { type: "help" };
    case "LINK": {
      const code = arg.replace(/[\s-]/g, "").toUpperCase();
      return { type: "link", code: code || null };
    }
    case "FRIDGE":
    case "PANTRY": {
      const pm = /^(?:page\s*)?(\d{1,3})$/i.exec(arg);
      return { type: "fridge", page: pm ? Math.max(1, Number(pm[1])) : 1 };
    }
    case "MORE":
    case "NEXT":
      return { type: "more" };
    case "RESCUE":
    case "COOK":
      return { type: "rescue" };
    case "CLEAR":
      return { type: "clear", name: arg || null };
    case "ADD":
    case "SAVE":
      return { type: "add" };
    case "STOP":
    case "STOPALL":
    case "UNSUBSCRIBE":
    case "QUIT":
      return { type: "stop" };
    case "START":
    case "UNSTOP":
    case "SUBSCRIBE":
      return { type: "start" };
    case "CANCEL":
      return { type: "cancel" };
    case "REMIND":
      return { type: "remind", hour: arg ? parseRemindHour(arg) : null, raw: arg };
    case "TZ":
    case "TIMEZONE":
      return { type: "tz", zone: arg || null };
    default:
  }

  if (looksLikeIngredients(cleaned)) {
    const text = cleaned.replace(/^ingredients?\s*[:\-]\s*/i, "").slice(0, MAX_INGREDIENT_TEXT).trim();
    if (!text) return { type: "unknown", text: cleaned.slice(0, 200) };
    return { type: "ingredients", text };
  }
  return { type: "unknown", text: cleaned.slice(0, 200) };
}

/** Heuristic: a list-like paragraph, or something prefixed with "Ingredients:". */
export function looksLikeIngredients(text: string): boolean {
  if (/^ingredients?\s*[:\-]/i.test(text)) return true;
  const commas = (text.match(/,/g) ?? []).length;
  return text.length >= 20 && commas >= 2;
}
