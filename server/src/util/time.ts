/** Parse a date/time string into canonical ISO-8601 UTC, or null if unparseable. */
export function toIso(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** True iff both instants are known and a is strictly earlier than b. */
export function isStrictlyBefore(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return Date.parse(a) < Date.parse(b);
}

export function maxIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v !== null && (best === null || Date.parse(v) > Date.parse(best))) best = v;
  }
  return best;
}
