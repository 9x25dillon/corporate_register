import type { Decision } from "../core/decide.js";
import type {
  Briefing,
  BroadcastMode,
  Citation,
  Domain,
  EventBundle,
  EventKind,
  FetchRecord,
  IngestReport,
  LegalEvent,
  LegalObject,
  ObjectSnapshot,
  RunStatus,
  SourceDocument,
  SourceId
} from "../core/types.js";

export interface EventQuery {
  kinds?: EventKind[];
  sources?: SourceId[];
  domains?: Domain[];
  /** Exclusive lower bound on observedAt. */
  since?: string | null;
  /** Inclusive upper bound on observedAt. */
  until?: string;
  limit: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Persistence port. Implementations hold no domain logic: transition semantics
 * live in the pure decide() function that `apply` executes under a per-object lock.
 *
 * Contract (verified by test/store-contract.test.ts against every implementation):
 *   - putDocument is idempotent on id; the first fetchedAt wins.
 *   - apply() is atomic and serialised per stateKey; the decision it returns
 *     is exactly what was persisted.
 *   - events, citations, claims and documents are immutable once written.
 *   - listEvents orders by observedAt desc, then id asc.
 */
export interface Store {
  readonly kind: "memory" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;

  /** Run fn while holding the global ingestion lock; never waits for it. */
  withIngestLock<T>(fn: () => Promise<T>): Promise<LockResult<T>>;
  beginRun(runId: string, startedAt: string): Promise<void>;
  finishRun(report: IngestReport): Promise<void>;
  listRuns(limit: number): Promise<{ runId: string; startedAt: string; finishedAt: string | null; status: RunStatus; report: IngestReport | null }[]>;

  putDocument(doc: SourceDocument): Promise<{ inserted: boolean }>;
  getDocument(id: string): Promise<SourceDocument | null>;
  putFetch(record: FetchRecord): Promise<void>;

  apply(stateKey: string, decide: (snapshot: ObjectSnapshot | null) => Decision): Promise<Decision>;

  getObject(stateKey: string): Promise<LegalObject | null>;
  objectHistory(stateKey: string): Promise<LegalEvent[]>;
  listEvents(query: EventQuery): Promise<LegalEvent[]>;
  getBundles(eventIds: readonly string[]): Promise<EventBundle[]>;
  getCitation(id: string): Promise<Citation | null>;
  getCitations(ids: readonly string[]): Promise<Citation[]>;

  putBriefing(briefing: Briefing): Promise<void>;
  getBriefing(id: string): Promise<Briefing | null>;
  latestBriefing(mode: BroadcastMode): Promise<Briefing | null>;
}
