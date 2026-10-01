import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { verifyCitation } from "../core/provenance.js";
import { DOMAINS, EVENT_KINDS, SOURCES, type BroadcastMode, type Briefing } from "../core/types.js";
import { runIngestion, type PipelineDeps } from "../ingest/pipeline.js";
import { AUDIO_FILENAME, ConflictError, type BriefingService } from "../services/briefing.js";
import { TtsError } from "../services/elevenlabs.js";
import type { Store } from "../store/store.js";
import { sha256 } from "../util/hash.js";

export interface ServerDeps {
  store: Store;
  briefings: BriefingService;
  ingest: Omit<PipelineDeps, "store" | "log">;
  disabledSources: { source: string; reason: string }[];
  audioDir: string;
  apiToken?: string | undefined;
  ttsConfigured: boolean;
  logLevel?: string;
}

const isoString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 timestamp");
const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(values)).optional());

const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  kind: csv(EVENT_KINDS),
  source: csv(SOURCES),
  domain: csv(DOMAINS),
  since: isoString.optional(),
  until: isoString.optional()
});

const briefingBody = z
  .object({
    limit: z.number().int().min(1).max(50).default(12),
    synthesize: z.boolean().default(false),
    since: isoString.nullable().optional()
  })
  .default({ limit: 12, synthesize: false });

const MODES_WITH_COMPILERS: readonly BroadcastMode[] = ["what-changed"];

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logLevel === "silent" || deps.logLevel === undefined ? false : { level: deps.logLevel },
    bodyLimit: 64 * 1024
  });
  const requireToken = tokenGuard(deps.apiToken);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
    if (err instanceof TtsError) {
      req.log.error({ status: err.status }, err.message);
      return reply.code(502).send({ error: "speech synthesis failed", upstreamStatus: err.status });
    }
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({
    status: "ok",
    store: deps.store.kind,
    durable: deps.store.kind === "postgres",
    database: await deps.store.ping(),
    sources: {
      enabled: deps.ingest.adapters.map((a) => a.id),
      disabled: deps.disabledSources
    },
    tts: deps.ttsConfigured
  }));

  // ── Ingestion ──────────────────────────────────────────────────────────────
  app.post("/v1/ingest", { preHandler: requireToken }, async (req, reply) => {
    const outcome = await runIngestion({ ...deps.ingest, store: deps.store, log: req.log });
    if (outcome.status === "skipped") return reply.code(409).send({ error: outcome.reason });
    return outcome.report;
  });

  app.get("/v1/ingest/runs", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    return { runs: await deps.store.listRuns(limit) };
  });

  // ── Ledger ─────────────────────────────────────────────────────────────────
  app.get("/v1/events", async (req) => {
    const q = eventsQuery.parse(req.query);
    const events = await deps.store.listEvents({
      limit: q.limit,
      kinds: q.kind,
      sources: q.source,
      domains: q.domain,
      since: q.since ?? null,
      until: q.until
    });
    return { events };
  });

  app.get("/v1/changes", async (req) => {
    const q = eventsQuery.parse(req.query);
    const events = await deps.store.listEvents({
      limit: q.limit,
      kinds: q.kind?.filter((k) => k !== "baseline") ?? ["transition", "occurrence"],
      sources: q.source,
      domains: q.domain,
      since: q.since ?? null,
      until: q.until
    });
    return { changes: await deps.store.getBundles(events.map((e) => e.id)) };
  });

  app.get("/v1/events/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    const [bundle] = await deps.store.getBundles([id]);
    return bundle ?? reply.code(404).send({ error: "event not found" });
  });

  app.get("/v1/objects/:stateKey", async (req, reply) => {
    const { stateKey } = z.object({ stateKey: z.string().min(3).max(200) }).parse(req.params);
    const object = await deps.store.getObject(stateKey);
    if (!object) return reply.code(404).send({ error: "object not found" });
    return { object, history: await deps.store.objectHistory(stateKey) };
  });

  // ── Provenance ─────────────────────────────────────────────────────────────
  app.get("/v1/citations/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    const citation = await deps.store.getCitation(id);
    if (!citation) return reply.code(404).send({ error: "citation not found" });
    const doc = await deps.store.getDocument(citation.documentId);
    return {
      citation,
      document: doc && { id: doc.id, source: doc.source, url: doc.url, contentType: doc.contentType, byteLength: doc.byteLength, fetchedAt: doc.fetchedAt },
      rawUrlPath: `/v1/documents/${citation.documentId}/raw`
    };
  });

  app.get("/v1/citations/:id/verify", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    const citation = await deps.store.getCitation(id);
    if (!citation) return reply.code(404).send({ error: "citation not found" });
    const doc = await deps.store.getDocument(citation.documentId);
    if (!doc) return reply.code(404).send({ error: "cited document missing" });
    return verifyCitation(citation, doc);
  });

  app.get("/v1/documents/:id/raw", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params);
    const doc = await deps.store.getDocument(id);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    // Third-party bytes: never let a browser render them as active content.
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("x-docket-sha256", sha256(doc.body))
      .header("x-docket-source-url", doc.url)
      .send(doc.body);
  });

  // ── Briefings ──────────────────────────────────────────────────────────────
  app.post("/v1/briefings/what-changed", { preHandler: requireToken }, async (req, reply) => {
    const body = briefingBody.parse(req.body ?? {});
    const briefing = await deps.briefings.whatChanged(body);
    return reply.code(201).send(await expand(deps.store, briefing));
  });

  app.get("/v1/briefings/latest", async (req, reply) => {
    const { mode } = z.object({ mode: z.enum(MODES_WITH_COMPILERS as [BroadcastMode, ...BroadcastMode[]]).default("what-changed") }).parse(req.query);
    const briefing = await deps.store.latestBriefing(mode);
    return briefing ? expand(deps.store, briefing) : reply.code(404).send({ error: "no briefing yet" });
  });

  app.get("/v1/briefings/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    const briefing = await deps.store.getBriefing(id);
    return briefing ? expand(deps.store, briefing) : reply.code(404).send({ error: "briefing not found" });
  });

  app.get("/v1/audio/:filename", async (req, reply) => serveAudio(req, reply, deps.audioDir));

  return app;
}

/** Attach the citation records referenced by the manifest, keyed by id. */
async function expand(store: Store, briefing: Briefing) {
  const citations = await store.getCitations(briefing.citationIds);
  return { ...briefing, citations: Object.fromEntries(citations.map((c) => [c.id, c])) };
}

function tokenGuard(token: string | undefined) {
  const expected = token ? Buffer.from(sha256(token), "hex") : null;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (expected === null) return;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ok = presented.length > 0 && timingSafeEqual(Buffer.from(sha256(presented), "hex"), expected);
    if (!ok) return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
  };
}

/** Serve MP3 with single-range support (AVPlayer and ExoPlayer seek via Range). */
async function serveAudio(req: FastifyRequest, reply: FastifyReply, audioDir: string) {
  const { filename } = req.params as { filename: string };
  if (!AUDIO_FILENAME.test(filename)) return reply.code(404).send({ error: "not found" });
  const file = path.join(path.resolve(audioDir), filename);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return reply.code(404).send({ error: "not found" });
  }

  reply
    .header("content-type", "audio/mpeg")
    .header("accept-ranges", "bytes")
    .header("cache-control", "public, max-age=31536000, immutable");

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range || (range[1] === "" && range[2] === "")) {
    return reply.header("content-length", size).send(createReadStream(file));
  }
  let start: number;
  let end: number;
  if (range[1] === "") {
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start >= size || start > end) {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }
  return reply
    .code(206)
    .header("content-range", `bytes ${start}-${end}/${size}`)
    .header("content-length", end - start + 1)
    .send(createReadStream(file, { start, end }));
}
