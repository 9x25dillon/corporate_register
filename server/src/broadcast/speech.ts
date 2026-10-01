import type { SourceId } from "../core/types.js";
import { plainText, truncate } from "../util/text.js";

/**
 * Convert untrusted source text into narration-safe text.
 *
 * ElevenLabs v4 interprets [square-bracket] spans as delivery directions, so a
 * press-release title containing "[whispers]" would otherwise steer the voice.
 * Delivery is the compiler's job alone: every bracket from a source becomes a
 * parenthesis, and every narrated value ends with terminal punctuation.
 */
export function speakable(input: string, maxLength = 360): string {
  const text = plainText(input)
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/[{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = truncate(text, maxLength).replace(/…$/, "");
  if (clipped === "") return "";
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped.replace(/[,;:\s]+$/, "")}.`;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "2026-09-29T00:00:00Z" → "September 29, 2026". Dates are rendered in UTC. */
export function spokenDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : MONTH.format(new Date(ms));
}

export const SOURCE_LABEL: Record<SourceId, string> = {
  congress: "Congress",
  sec: "Securities filing",
  ftc: "Federal Trade Commission",
  doj: "Department of Justice, Antitrust Division"
};

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n]! : String(n);
}

/** spokenCount(3, "change") → "Three changes". */
export function spokenCount(n: number, singular: string, plural = `${singular}s`): string {
  const head = numberWord(n);
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} ${n === 1 ? singular : plural}`;
}
