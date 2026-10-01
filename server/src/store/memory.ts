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
import type { EventQuery, LockResult, Store } from "./store.js";

const clone = <T>(v: T): T => structuredClone(v);

interface RunRow {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  report: IngestReport | null;
}

/**
 * Non-durable reference implementation of the Store contract.
 * Atomicity of apply(): decide() is synchronous and there is no await between
 * the snapshot read and the writes, so the JS event loop serialises it.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private documents = new Map<string, SourceDocument>();
  private fetches: FetchRecord[] = [];
  private objects = new Map<string, LegalObject>();
  private events = new Map<string, LegalEvent>();
  private claims = new Map<string, Claim[]>();
  private citations = new Map<string, Citation>();
  private briefings = new Map<string, Briefing>();
  private runs = new Map<string, RunRow>();
  private ingestLocked = false;

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }

  async withIngestLock<T>(fn: () => Promise<T>): Promise<LockResult<T>> {
    if (this.ingestLocked) return { acquired: false };
    this.ingestLocked = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.ingestLocked = false;
    }
  }

  async beginRun(runId: string, startedAt: string): Promise<void> {
    this.runs.set(runId, { runId, startedAt, finishedAt: null, status: "running", report: null });
  }

  async finishRun(report: IngestReport): Promise<void> {
    this.runs.set(report.runId, {
      runId: report.runId,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      status: report.status,
      report: clone(report)
    });
  }

  async listRuns(limit: number): Promise<RunRow[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(clone);
  }

  async putDocument(doc: SourceDocument): Promise<{ inserted: boolean }> {
    if (this.documents.has(doc.id)) return { inserted: false };
    this.documents.set(doc.id, { ...doc, body: Buffer.from(doc.body) });
    return { inserted: true };
  }

  async getDocument(id: string): Promise<SourceDocument | null> {
    const doc = this.documents.get(id);
    return doc ? { ...doc, body: Buffer.from(doc.body) } : null;
  }

  async putFetch(record: FetchRecord): Promise<void> {
    if (record.documentId !== null && !this.documents.has(record.documentId)) {
      throw new Error(`fetch ${record.id} references unknown document ${record.documentId}`);
    }
    this.fetches.push(clone(record));
  }

  async apply(stateKey: string, decideFn: (snapshot: ObjectSnapshot | null) => Decision): Promise<Decision> {
    const object = this.objects.get(stateKey);
    let snapshot: ObjectSnapshot | null = null;
    if (object !== undefined) {
      const stateClaim = this.claims.get(object.currentEventId)?.find((c) => c.field === "newState");
      if (stateClaim === undefined) throw new Error(`object ${stateKey} has no current newState claim`);
      snapshot = { object: clone(object), stateClaim: clone(stateClaim) };
    }

    const decision = decideFn(snapshot);
    if (decision.stateKey !== stateKey) throw new Error("decision stateKey mismatch");

    switch (decision.type) {
      case "stale":
        break;
      case "unchanged":
        this.objects.set(stateKey, clone(decision.object));
        break;
      case "created":
      case "transitioned": {
        const { event, claims, citations } = decision.bundle;
        if (this.events.has(event.id)) throw new Error(`event ${event.id} already exists`);
        for (const c of citations) {
          if (!this.documents.has(c.documentId)) throw new Error(`citation ${c.id} references unknown document`);
        }
        const known = new Set([...this.citations.keys(), ...citations.map((c) => c.id)]);
        for (const claim of claims) {
          for (const id of claim.citationIds) {
            if (!known.has(id)) throw new Error(`claim ${claim.field} references unknown citation ${id}`);
          }
        }
        this.events.set(event.id, clone(event));
        for (const c of citations) this.citations.set(c.id, clone(c));
        this.claims.set(event.id, clone(claims));
        this.objects.set(stateKey, clone(decision.object));
        break;
      }
    }
    return decision;
  }

  async getObject(stateKey: string): Promise<LegalObject | null> {
    const o = this.objects.get(stateKey);
    return o ? clone(o) : null;
  }

  async objectHistory(stateKey: string): Promise<LegalEvent[]> {
    return [...this.events.values()]
      .filter((e) => e.stateKey === stateKey)
      .sort((a, b) => a.revision - b.revision)
      .map(clone);
  }

  async listEvents(q: EventQuery): Promise<LegalEvent[]> {
    const since = q.since ? Date.parse(q.since) : null;
    const until = q.until ? Date.parse(q.until) : null;
    return [...this.events.values()]
      .filter((e) => {
        const t = Date.parse(e.observedAt);
        return (
          (!q.kinds || q.kinds.includes(e.kind)) &&
          (!q.sources || q.sources.includes(e.source)) &&
          (!q.domains || q.domains.includes(e.domain)) &&
          (since === null || t > since) &&
          (until === null || t <= until)
        );
      })
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id))
      .slice(0, q.limit)
      .map(clone);
  }

  async getBundles(eventIds: readonly string[]): Promise<EventBundle[]> {
    const out: EventBundle[] = [];
    for (const id of eventIds) {
      const event = this.events.get(id);
      if (event === undefined) continue;
      const claims = [...(this.claims.get(id) ?? [])].sort(
        (a, b) => CLAIM_FIELDS.indexOf(a.field) - CLAIM_FIELDS.indexOf(b.field)
      );
      const citationIds = [...new Set(claims.flatMap((c) => c.citationIds))];
      const citations = citationIds.map((cid) => this.citations.get(cid)).filter((c): c is Citation => c !== undefined);
      out.push(clone({ event, claims, citations }));
    }
    return out;
  }

  async getCitation(id: string): Promise<Citation | null> {
    const c = this.citations.get(id);
    return c ? clone(c) : null;
  }

  async getCitations(ids: readonly string[]): Promise<Citation[]> {
    return ids.map((id) => this.citations.get(id)).filter((c): c is Citation => c !== undefined).map(clone);
  }

  async putBriefing(b: Briefing): Promise<void> {
    if (this.briefings.has(b.id)) throw new Error(`briefing ${b.id} already exists`);
    this.briefings.set(b.id, clone(b));
  }

  async getBriefing(id: string): Promise<Briefing | null> {
    const b = this.briefings.get(id);
    return b ? clone(b) : null;
  }

  async latestBriefing(mode: BroadcastMode): Promise<Briefing | null> {
    let best: Briefing | null = null;
    for (const b of this.briefings.values()) {
      if (b.mode !== mode) continue;
      if (best === null || b.createdAt > best.createdAt || (b.createdAt === best.createdAt && b.id > best.id)) best = b;
    }
    return best ? clone(best) : null;
  }
}
