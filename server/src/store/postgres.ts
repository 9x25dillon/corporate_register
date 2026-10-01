import { gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";
import type { Decision } from "../core/decide.js";
import {
  CLAIM_FIELDS,
  type Briefing,
  type BroadcastMode,
  type Citation,
  type Claim,
  type EventBundle,
  type FetchRecord,
  type IngestReport,
  type LegalEvent,
  type LegalObject,
  type ObjectSnapshot,
  type RunStatus,
  type SourceDocument
} from "../core/types.js";
import { migrate } from "./migrate.js";
import type { EventQuery, LockResult, Store } from "./store.js";

/** Advisory-lock key pair for the ingestion worker (two-int4 key space). */
const INGEST_LOCK: [number, number] = [0x646b74, 1];

type Row = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function toEvent(r: Row): LegalEvent {
  return {
    id: r.id,
    kind: r.kind,
    stateKey: r.state_key,
    revision: r.revision,
    source: r.source,
    domain: r.domain,
    title: r.title,
    summary: r.summary,
    actors: r.actors,
    instrument: r.instrument,
    action: r.action,
    previousState: r.previous_state,
    previousFingerprint: r.previous_fingerprint,
    previousStatePublishedAt: isoOrNull(r.previous_state_published_at),
    previousProceduralStage: r.previous_procedural_stage,
    newState: r.new_state,
    fingerprint: r.fingerprint,
    statePublishedAt: isoOrNull(r.state_published_at),
    proceduralStage: r.procedural_stage,
    nextExpectedStage: r.next_expected_stage,
    significance: r.significance,
    observedAt: iso(r.observed_at)
  };
}

function toObject(r: Row): LegalObject {
  return {
    stateKey: r.state_key,
    source: r.source,
    domain: r.domain,
    title: r.title,
    instrument: r.instrument,
    currentState: r.current_state,
    fingerprint: r.fingerprint,
    revision: r.revision,
    currentEventId: r.current_event_id,
    proceduralStage: r.procedural_stage,
    statePublishedAt: isoOrNull(r.state_published_at),
    firstSeenAt: iso(r.first_seen_at),
    lastChangedAt: iso(r.last_changed_at),
    lastObservedAt: iso(r.last_observed_at),
    observationCount: r.observation_count
  };
}

function toCitation(r: Row): Citation {
  return {
    id: r.id,
    eventId: r.event_id,
    documentId: r.document_id,
    locator: r.locator,
    url: r.url,
    title: r.title,
    publisher: r.publisher,
    excerpt: r.excerpt,
    publishedAt: isoOrNull(r.published_at),
    retrievedAt: iso(r.retrieved_at)
  };
}

function toBriefing(r: Row): Briefing {
  return {
    id: r.id,
    mode: r.mode,
    title: r.title,
    createdAt: iso(r.created_at),
    windowStart: isoOrNull(r.window_start),
    windowEnd: iso(r.window_end),
    script: r.script,
    segments: r.segments,
    eventIds: r.event_ids,
    citationIds: r.citation_ids,
    audio: r.audio
  };
}

const CLAIMS_SQL = `
  select c.event_id, c.field, c.value, c.basis, c.rule,
         coalesce(array_agg(cc.citation_id order by cc.ordinal) filter (where cc.citation_id is not null), '{}') as citation_ids
    from event_claims c
    left join claim_citations cc on cc.event_id = c.event_id and cc.field = c.field
   where c.event_id = any($1::text[])
   group by c.event_id, c.field, c.value, c.basis, c.rule`;

function toClaim(r: Row): Claim {
  return { eventId: r.event_id, field: r.field, value: r.value, basis: r.basis, rule: r.rule, citationIds: r.citation_ids };
}

export interface PostgresStoreOptions {
  connectionString: string;
  poolMax?: number;
  /** Apply pending migrations during init(). Default true. */
  migrate?: boolean;
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;
  private readonly runMigrations: boolean;

  constructor(opts: PostgresStoreOptions) {
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.poolMax ?? 10 });
    this.runMigrations = opts.migrate ?? true;
    // An idle client error must not crash the process; the pool discards the client.
    this.pool.on("error", () => undefined);
  }

  async init(): Promise<void> {
    if (this.runMigrations) await migrate(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async withIngestLock<T>(fn: () => Promise<T>): Promise<LockResult<T>> {
    // Session-level lock on a dedicated connection: released explicitly, or by
    // the server if this process dies mid-run.
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1, $2) as ok", INGEST_LOCK);
      if (!rows[0]?.ok) return { acquired: false };
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await client.query("select pg_advisory_unlock($1, $2)", INGEST_LOCK);
      }
    } finally {
      client.release();
    }
  }

  async beginRun(runId: string, startedAt: string): Promise<void> {
    await this.pool.query("insert into ingest_runs (id, started_at, status) values ($1, $2, 'running')", [runId, startedAt]);
  }

  async finishRun(report: IngestReport): Promise<void> {
    await this.pool.query("update ingest_runs set finished_at = $2, status = $3, report = $4 where id = $1", [
      report.runId,
      report.finishedAt,
      report.status,
      JSON.stringify(report)
    ]);
  }

  async listRuns(limit: number) {
    const { rows } = await this.pool.query("select * from ingest_runs order by started_at desc, id limit $1", [limit]);
    return rows.map((r: Row) => ({
      runId: r.id as string,
      startedAt: iso(r.started_at),
      finishedAt: isoOrNull(r.finished_at),
      status: r.status as RunStatus,
      report: (r.report ?? null) as IngestReport | null
    }));
  }

  async putDocument(doc: SourceDocument): Promise<{ inserted: boolean }> {
    const { rowCount } = await this.pool.query(
      `insert into source_documents (id, source, url, content_type, byte_length, encoding, body, fetched_at)
       values ($1, $2, $3, $4, $5, 'gzip', $6, $7)
       on conflict (id) do nothing`,
      [doc.id, doc.source, doc.url, doc.contentType, doc.byteLength, gzipSync(doc.body), doc.fetchedAt]
    );
    return { inserted: rowCount === 1 };
  }

  async getDocument(id: string): Promise<SourceDocument | null> {
    const { rows } = await this.pool.query("select * from source_documents where id = $1", [id]);
    const r = rows[0] as Row | undefined;
    if (!r) return null;
    const body: Buffer = r.encoding === "gzip" ? gunzipSync(r.body) : r.body;
    return {
      id: r.id,
      source: r.source,
      url: r.url,
      contentType: r.content_type,
      byteLength: r.byte_length,
      fetchedAt: iso(r.fetched_at),
      body
    };
  }

  async putFetch(f: FetchRecord): Promise<void> {
    await this.pool.query(
      `insert into fetch_log (id, run_id, source, url, started_at, finished_at, http_status, document_id, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [f.id, f.runId, f.source, f.url, f.startedAt, f.finishedAt, f.httpStatus, f.documentId, f.error]
    );
  }

  async apply(stateKey: string, decideFn: (snapshot: ObjectSnapshot | null) => Decision): Promise<Decision> {
    return this.tx(async (c) => {
      // Serialise all writers of this object, including the not-yet-existing case
      // that a row lock could not cover.
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [stateKey]);

      const objectRow = (await c.query("select * from legal_objects where state_key = $1", [stateKey])).rows[0] as Row | undefined;
      let snapshot: ObjectSnapshot | null = null;
      if (objectRow) {
        const object = toObject(objectRow);
        const claimRows = (await c.query(CLAIMS_SQL, [[object.currentEventId]])).rows as Row[];
        const stateClaim = claimRows.map(toClaim).find((cl) => cl.field === "newState");
        if (!stateClaim) throw new Error(`object ${stateKey} has no current newState claim`);
        snapshot = { object, stateClaim };
      }

      const decision = decideFn(snapshot);
      if (decision.stateKey !== stateKey) throw new Error("decision stateKey mismatch");

      if (decision.type === "unchanged") {
        await c.query("update legal_objects set last_observed_at = $2, observation_count = $3 where state_key = $1", [
          stateKey,
          decision.object.lastObservedAt,
          decision.object.observationCount
        ]);
      } else if (decision.type === "created" || decision.type === "transitioned") {
        await this.writeBundle(c, decision.bundle);
        await this.upsertObject(c, decision.object);
      }
      return decision;
    });
  }

  private async writeBundle(c: pg.PoolClient, { event: e, claims, citations }: EventBundle): Promise<void> {
    await c.query(
      `insert into legal_events (
         id, kind, state_key, revision, source, domain, title, summary, actors, instrument, action,
         previous_state, previous_fingerprint, previous_state_published_at, previous_procedural_stage,
         new_state, fingerprint, state_published_at, procedural_stage, next_expected_stage, significance, observed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        e.id, e.kind, e.stateKey, e.revision, e.source, e.domain, e.title, e.summary, e.actors, e.instrument, e.action,
        e.previousState, e.previousFingerprint, e.previousStatePublishedAt, e.previousProceduralStage,
        e.newState, e.fingerprint, e.statePublishedAt, e.proceduralStage, e.nextExpectedStage, e.significance, e.observedAt
      ]
    );
    for (const ci of citations) {
      await c.query(
        `insert into citations (id, event_id, document_id, locator, url, title, publisher, excerpt, published_at, retrieved_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ci.id, ci.eventId, ci.documentId, ci.locator, ci.url, ci.title, ci.publisher, ci.excerpt, ci.publishedAt, ci.retrievedAt]
      );
    }
    for (const cl of claims) {
      await c.query("insert into event_claims (event_id, field, value, basis, rule) values ($1,$2,$3,$4,$5)", [
        cl.eventId, cl.field, cl.value, cl.basis, cl.rule
      ]);
      if (cl.citationIds.length > 0) {
        await c.query(
          `insert into claim_citations (event_id, field, ordinal, citation_id)
           select $1, $2, t.ord - 1, t.id from unnest($3::text[]) with ordinality as t(id, ord)`,
          [cl.eventId, cl.field, cl.citationIds]
        );
      }
    }
  }

  private async upsertObject(c: pg.PoolClient, o: LegalObject): Promise<void> {
    await c.query(
      `insert into legal_objects (
         state_key, source, domain, title, instrument, current_state, fingerprint, revision, current_event_id,
         procedural_stage, state_published_at, first_seen_at, last_changed_at, last_observed_at, observation_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (state_key) do update set
         source = excluded.source, domain = excluded.domain, title = excluded.title, instrument = excluded.instrument,
         current_state = excluded.current_state, fingerprint = excluded.fingerprint, revision = excluded.revision,
         current_event_id = excluded.current_event_id, procedural_stage = excluded.procedural_stage,
         state_published_at = excluded.state_published_at, last_changed_at = excluded.last_changed_at,
         last_observed_at = excluded.last_observed_at, observation_count = excluded.observation_count`,
      [
        o.stateKey, o.source, o.domain, o.title, o.instrument, o.currentState, o.fingerprint, o.revision, o.currentEventId,
        o.proceduralStage, o.statePublishedAt, o.firstSeenAt, o.lastChangedAt, o.lastObservedAt, o.observationCount
      ]
    );
  }

  async getObject(stateKey: string): Promise<LegalObject | null> {
    const { rows } = await this.pool.query("select * from legal_objects where state_key = $1", [stateKey]);
    return rows[0] ? toObject(rows[0]) : null;
  }

  async objectHistory(stateKey: string): Promise<LegalEvent[]> {
    const { rows } = await this.pool.query("select * from legal_events where state_key = $1 order by revision", [stateKey]);
    return rows.map(toEvent);
  }

  async listEvents(q: EventQuery): Promise<LegalEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.kinds) add("kind = any(?::text[])", q.kinds);
    if (q.sources) add("source = any(?::text[])", q.sources);
    if (q.domains) add("domain = any(?::text[])", q.domains);
    if (q.since) add("observed_at > ?", q.since);
    if (q.until) add("observed_at <= ?", q.until);
    params.push(q.limit);
    const sql = `select * from legal_events ${where.length ? `where ${where.join(" and ")}` : ""}
                 order by observed_at desc, id asc limit $${params.length}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(toEvent);
  }

  async getBundles(eventIds: readonly string[]): Promise<EventBundle[]> {
    if (eventIds.length === 0) return [];
    const ids = [...eventIds];
    const events = (await this.pool.query("select * from legal_events where id = any($1::text[])", [ids])).rows.map(toEvent);
    const claims = (await this.pool.query(CLAIMS_SQL, [ids])).rows.map(toClaim);
    const citationIds = [...new Set(claims.flatMap((c) => c.citationIds))];
    const citations = new Map((await this.getCitations(citationIds)).map((c) => [c.id, c]));
    const byId = new Map(events.map((e) => [e.id, e]));

    return ids.flatMap((id) => {
      const event = byId.get(id);
      if (!event) return [];
      const own = claims
        .filter((c) => c.eventId === id)
        .sort((a, b) => CLAIM_FIELDS.indexOf(a.field) - CLAIM_FIELDS.indexOf(b.field));
      const cits = [...new Set(own.flatMap((c) => c.citationIds))]
        .map((cid) => citations.get(cid))
        .filter((c): c is Citation => c !== undefined);
      return [{ event, claims: own, citations: cits }];
    });
  }

  async getCitation(id: string): Promise<Citation | null> {
    const { rows } = await this.pool.query("select * from citations where id = $1", [id]);
    return rows[0] ? toCitation(rows[0]) : null;
  }

  async getCitations(ids: readonly string[]): Promise<Citation[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query("select * from citations where id = any($1::text[])", [[...ids]]);
    const byId = new Map(rows.map((r: Row) => [r.id as string, toCitation(r)]));
    return ids.map((id) => byId.get(id)).filter((c): c is Citation => c !== undefined);
  }

  async putBriefing(b: Briefing): Promise<void> {
    await this.pool.query(
      `insert into briefings (id, mode, title, created_at, window_start, window_end, script, segments, event_ids, citation_ids, audio)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        b.id, b.mode, b.title, b.createdAt, b.windowStart, b.windowEnd, b.script,
        JSON.stringify(b.segments), b.eventIds, b.citationIds, b.audio === null ? null : JSON.stringify(b.audio)
      ]
    );
  }

  async getBriefing(id: string): Promise<Briefing | null> {
    const { rows } = await this.pool.query("select * from briefings where id = $1", [id]);
    return rows[0] ? toBriefing(rows[0]) : null;
  }

  async latestBriefing(mode: BroadcastMode): Promise<Briefing | null> {
    const { rows } = await this.pool.query(
      "select * from briefings where mode = $1 order by created_at desc, id desc limit 1",
      [mode]
    );
    return rows[0] ? toBriefing(rows[0]) : null;
  }
}
