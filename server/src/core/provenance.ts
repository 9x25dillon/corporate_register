import { XMLParser } from "fast-xml-parser";
import { sha256 } from "../util/hash.js";
import type { Citation, SourceDocument } from "./types.js";

export interface CitationVerification {
  citationId: string;
  documentId: string;
  /** sha256(stored bytes) equals the document id: bytes are unaltered. */
  documentIntact: boolean;
  /** The locator resolves to a node inside the document. */
  locatorResolved: boolean;
  /** The resolved node (JSON value or parsed XML element), when found. */
  node: unknown;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, processEntities: true, htmlEntities: true });

/** RFC 6901 token unescaping. */
const unescapeToken = (t: string) => t.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Walk a locator through a parsed tree. Numeric tokens index arrays; XML
 * parsers collapse single-child lists to objects, so index 0 on a non-array
 * selects the node itself.
 */
export function walk(root: unknown, locator: string): { found: boolean; node: unknown } {
  if (locator === "" || locator === "/") return { found: true, node: root };
  if (!locator.startsWith("/")) return { found: false, node: undefined };
  let node: unknown = root;
  for (const raw of locator.slice(1).split("/")) {
    const token = unescapeToken(raw);
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(token)) return { found: false, node: undefined };
      node = node[Number(token)];
    } else if (node !== null && typeof node === "object") {
      if (/^\d+$/.test(token) && !(token in node)) {
        if (token !== "0") return { found: false, node: undefined };
        continue;
      }
      node = (node as Record<string, unknown>)[token];
    } else {
      return { found: false, node: undefined };
    }
    if (node === undefined) return { found: false, node: undefined };
  }
  return { found: true, node };
}

export function verifyCitation(citation: Citation, doc: SourceDocument): CitationVerification {
  const documentIntact = doc.id === citation.documentId && sha256(doc.body) === doc.id;
  let parsed: unknown;
  const text = doc.body.toString("utf8");
  try {
    parsed = /^\s*[[{]/.test(text) ? JSON.parse(text) : /<!ENTITY/i.test(text) ? undefined : xml.parse(text);
  } catch {
    parsed = undefined;
  }
  const { found, node } = parsed === undefined ? { found: false, node: undefined } : walk(parsed, citation.locator);
  return { citationId: citation.id, documentId: citation.documentId, documentIntact, locatorResolved: found, node: found ? node : null };
}
