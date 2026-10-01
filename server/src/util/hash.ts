import { createHash } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Unit separator: cannot appear in identifiers, so part boundaries are unambiguous. */
const SEP = "\u001f";

/** Deterministic 128-bit identifier derived from ordered parts. */
export function deriveId(...parts: readonly string[]): string {
  return sha256(parts.join(SEP)).slice(0, 32);
}

/** JSON with recursively sorted object keys: equal values => equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
