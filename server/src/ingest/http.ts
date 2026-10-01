import type { FetchRequest } from "./source.js";

export type FetchImpl = typeof fetch;

export interface RawResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

export interface HttpOptions {
  fetchImpl?: FetchImpl;
  timeoutMs: number;
  userAgent: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** GET with timeout and a hard size ceiling. Non-2xx yields HttpError carrying the status. */
export async function fetchRaw(req: FetchRequest, opts: HttpOptions): Promise<RawResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetchImpl(req.url, {
    method: "GET",
    headers: { "user-agent": opts.userAgent, ...req.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs)
  });
  if (!res.ok) {
    // Drain so the connection can be reused; keep only a short diagnostic.
    const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new HttpError(res.status, `HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`content-length ${declared} exceeds ${maxBytes}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > maxBytes) throw new Error(`body of ${body.byteLength} bytes exceeds ${maxBytes}`);
  return { status: res.status, contentType: res.headers.get("content-type"), body };
}
