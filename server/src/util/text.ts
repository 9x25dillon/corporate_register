const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  sect: "§"
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Remove markup, decode entities, drop control characters, collapse whitespace. */
export function plainText(input: string): string {
  const withoutTags = input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate at a sentence or word boundary, never mid-word. */
export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const window = input.slice(0, maxLength);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
  if (sentenceEnd >= maxLength * 0.5) return window.slice(0, sentenceEnd + 1);
  const space = window.lastIndexOf(" ");
  return `${(space > 0 ? window.slice(0, space) : window).replace(/[,;:\s]+$/, "")}…`;
}

export function splitList(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
