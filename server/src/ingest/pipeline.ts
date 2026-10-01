import { randomUUID } from "node:crypto";
import { decide } from "../core/decide.js";
import { validateObservation } from "../core/observation.js";
import type { IngestReport, RunStatus, SourceDocument, SourceRunStats } from "../core/types.js";
import type { Store } from "../store/store.js";
import { sha256 } from "../util/hash.js";
import { fetchRaw, HttpError, type FetchImpl } from "./http.js";
import { redactUrl, type SourceAdapter } from "./source.js";

export interface PipelineDeps {
  store: Store;
  adapters: readonly SourceAdapter[];
  http: { fetchImpl?: FetchImpl; timeoutMs: number; userAgent: string };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
}

export type IngestOutcome = { status: "completed"; report: IngestReport } | { status: "skipped"; reason: "ingest already running" };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One ingestion run:
 *
 *   plan ─► fetch ─► SourceDocument (sha256, immutable) ─► fetch_log
 *                          │
 *                          ▼
 *                  extract (pure) ─► validate ─► store.apply(decide)
 *
 * Sources run concurrently; requests within a source are sequential and
 * spaced by the adapter's minIntervalMs. A failure is contained to its
 * request (or document) and reported; it never aborts the run.
 */
export async function runIngestion(deps: PipelineDeps): Promise<IngestOutcome> {
  const lock = await deps.store.withIngestLock(() => ingestLocked(deps));
  return lock.acquired ? { status: "completed", report: lock.value } : { status: "skipped", reason: "ingest already running" };
}

async function ingestLocked(deps: PipelineDeps): Promise<IngestReport> {
  const now = deps.now ?? (() => new Date());
  const runId = randomUUID();
  const startedAt = now().toISOString();
  await deps.store.beginRun(runId, startedAt);

  const sources = await Promise.all(deps.adapters.map((a) => ingestSource(a, runId, deps, now)));
  const errored = sources.filter((s) => s.errors.length > 0).length;
  const status: RunStatus = errored === 0 ? "succeeded" : errored === sources.length ? "failed" : "partial";
  const report: IngestReport = { runId, startedAt, finishedAt: now().toISOString(), status, sources };
  await deps.store.finishRun(report);
  deps.log?.info({ runId, status, sources: sources.map(summarise) }, "ingest run finished");
  return report;
}

async function ingestSource(
  adapter: SourceAdapter,
  runId: string,
  deps: PipelineDeps,
  now: () => Date
): Promise<SourceRunStats> {
  const sleep = deps.sleep ?? defaultSleep;
  const stats: SourceRunStats = {
    source: adapter.id,
    requests: 0,
    documents: 0,
    newDocuments: 0,
    observations: 0,
    created: 0,
    transitioned: 0,
    unchanged: 0,
    stale: 0,
    errors: []
  };

  let requests;
  try {
    requests = adapter.plan();
  } catch (err) {
    stats.errors.push(`plan: ${(err as Error).message}`);
    return stats;
  }

  for (const [i, req] of requests.entries()) {
    if (i > 0 && adapter.minIntervalMs > 0) await sleep(adapter.minIntervalMs);
    stats.requests++;
    const url = redactUrl(req.url);
    const startedAt = now().toISOString();

    let doc: SourceDocument;
    try {
      const res = await fetchRaw(req, deps.http);
      const fetchedAt = now().toISOString();
      doc = {
        id: sha256(res.body),
        source: adapter.id,
        url,
        contentType: res.contentType,
        byteLength: res.body.byteLength,
        fetchedAt,
        body: res.body
      };
      const { inserted } = await deps.store.putDocument(doc);
      stats.documents++;
      if (inserted) stats.newDocuments++;
      await deps.store.putFetch({
        id: randomUUID(),
        runId,
        source: adapter.id,
        url,
        startedAt,
        finishedAt: fetchedAt,
        httpStatus: res.status,
        documentId: doc.id,
        error: null
      });
    } catch (err) {
      const message = `${req.label}: ${(err as Error).message}`;
      stats.errors.push(message);
      deps.log?.warn({ source: adapter.id, url, err: message }, "fetch failed");
      await deps.store
        .putFetch({
          id: randomUUID(),
          runId,
          source: adapter.id,
          url,
          startedAt,
          finishedAt: now().toISOString(),
          httpStatus: err instanceof HttpError ? err.status : null,
          documentId: null,
          error: message.slice(0, 1000)
        })
        .catch(() => undefined);
      continue;
    }

    let observations;
    try {
      observations = adapter.extract({ request: req, documentId: doc.id, fetchedAt: doc.fetchedAt, text: doc.body.toString("utf8") });
    } catch (err) {
      stats.errors.push(`${req.label}: extract: ${(err as Error).message}`);
      continue;
    }

    for (const raw of observations) {
      stats.observations++;
      try {
        const obs = validateObservation(raw);
        const observedAt = now().toISOString();
        const decision = await deps.store.apply(obs.stateKey, (snapshot) =>
          decide(snapshot, obs, { observedAt, retrievedAt: doc.fetchedAt })
        );
        if (decision.type === "created") stats.created++;
        else if (decision.type === "transitioned") stats.transitioned++;
        else if (decision.type === "unchanged") stats.unchanged++;
        else stats.stale++;
      } catch (err) {
        stats.errors.push(`${raw.stateKey}: ${(err as Error).message.slice(0, 300)}`);
      }
    }
  }
  return stats;
}

function summarise(s: SourceRunStats) {
  return { source: s.source, created: s.created, transitioned: s.transitioned, unchanged: s.unchanged, errors: s.errors.length };
}
