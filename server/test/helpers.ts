import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractContext } from "../src/ingest/source.js";
import { sha256 } from "../src/util/hash.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(here, "fixtures", name), "utf8");
}

export function ctxFor(text: string, url = "https://example.test/feed"): ExtractContext {
  return { request: { url, label: "test" }, documentId: sha256(text), fetchedAt: "2026-10-01T00:00:00.000Z", text };
}

export interface FakeRoute {
  status?: number;
  body: string;
  contentType?: string;
}

/** fetch() double: routes by URL prefix; records every request. */
export function fakeFetch(routes: Record<string, FakeRoute | (() => FakeRoute)>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const route = routes[key]!;
    const r = typeof route === "function" ? route() : route;
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

/** Deterministic clock advancing one second per call. */
export function steppingClock(startIso: string) {
  let t = Date.parse(startIso);
  return {
    now: () => new Date((t += 1000)),
    set: (iso: string) => {
      t = Date.parse(iso);
    }
  };
}

export const congressWith = (mutate: (bills: any[]) => void): string => {
  const doc = JSON.parse(fixture("congress-bills.json"));
  mutate(doc.bills);
  return JSON.stringify(doc);
};
