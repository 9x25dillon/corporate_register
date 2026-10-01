import type { Observation, SourceId } from "../core/types.js";

export interface FetchRequest {
  url: string;
  /** Request headers. Credentials belong here, never in the URL. */
  headers?: Record<string, string>;
  label: string;
}

export interface ExtractContext {
  request: FetchRequest;
  documentId: string;
  fetchedAt: string;
  text: string;
}

/**
 * A source adapter is split in two:
 *   plan()    — which URLs to fetch (no I/O);
 *   extract() — pure function from one raw document to observations.
 * The pipeline owns all I/O, persistence and provenance, so adapters stay
 * trivially testable against stored documents and can be re-run over history.
 */
export interface SourceAdapter {
  readonly id: SourceId;
  /** Minimum spacing between requests to this source (fair-access policies). */
  readonly minIntervalMs: number;
  plan(): FetchRequest[];
  extract(ctx: ExtractContext): Observation[];
}

const SECRET_PARAMS = /^(api[_-]?key|apikey|key|token|access[_-]?token|signature|sig|password)$/i;

/** Remove credential-like query parameters before a URL is persisted or logged. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, "REDACTED");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}
