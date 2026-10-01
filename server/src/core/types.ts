/**
 * Domain contracts.
 *
 * Layering (each layer may only reference layers above it):
 *
 *   SourceDocument   immutable raw bytes, content-addressed (sha256)
 *        │
 *   Evidence         pointer into one document (locator + verbatim excerpt)
 *        │
 *   Observation      what an adapter extracted: "object K is in state S"
 *        │  decide()
 *   LegalEvent       a recorded change of K's state (revisioned, immutable)
 *   Citation         Evidence bound to the event that first used it
 *   Claim            one field of an event + the citations that support it
 *        │
 *   LegalObject      projection: current state of K (fold over its events)
 *        │
 *   Briefing         compiled script + sentence-level citation manifest
 */

export const SOURCES = ["congress", "sec", "ftc", "doj"] as const;
export type SourceId = (typeof SOURCES)[number];

export const DOMAINS = [
  "legislation",
  "securities",
  "competition",
  "enforcement",
  "case-law",
  "m-and-a",
  "corporate-governance",
  "other"
] as const;
export type Domain = (typeof DOMAINS)[number];

export const SIGNIFICANCE = ["routine", "notable", "major"] as const;
export type Significance = (typeof SIGNIFICANCE)[number];

/**
 * baseline   first observation of a stateful object; no prior state is known,
 *            so it is NOT a change and is excluded from What Changed?.
 * transition fingerprint differs from the stored state: a real change.
 * occurrence first observation of an inherently event-like item (press release).
 */
export const EVENT_KINDS = ["baseline", "transition", "occurrence"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * source   value is (a normalisation of) text present in the cited document.
 * derived  value is computed deterministically from cited values (e.g. stage diff).
 * inferred value is a heuristic expectation (e.g. next procedural stage).
 */
export const CLAIM_BASES = ["source", "derived", "inferred"] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];

export const CLAIM_FIELDS = [
  "newState",
  "previousState",
  "action",
  "difference",
  "nextExpectedStage"
] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];

export interface SourceDocument {
  /** sha256(body) in lowercase hex. Identical bytes => identical id. */
  id: string;
  source: SourceId;
  /** URL the bytes were fetched from, with credentials redacted. */
  url: string;
  contentType: string | null;
  byteLength: number;
  /** First time these exact bytes were fetched. */
  fetchedAt: string;
  body: Buffer;
}

export interface FetchRecord {
  id: string;
  runId: string;
  source: SourceId;
  url: string;
  startedAt: string;
  finishedAt: string;
  httpStatus: number | null;
  documentId: string | null;
  error: string | null;
}

export interface Evidence {
  documentId: string;
  /** RFC 6901 JSON pointer (JSON sources) or element path (XML sources). */
  locator: string;
  /** Canonical human-facing URL of the cited item (not the API URL). */
  url: string;
  title: string;
  publisher: string;
  /** Verbatim (markup-stripped) text from the document supporting the claims. */
  excerpt: string;
  publishedAt: string | null;
}

export interface Observation {
  source: SourceId;
  domain: Domain;
  kind: "stateful" | "occurrence";
  /** Identity of the legal object, e.g. congress:bill:119:hr:1234 */
  stateKey: string;
  title: string;
  summary: string;
  actors: string[];
  instrument: string | null;
  /** The trigger, verbatim from the source. */
  action: string;
  /** The resulting state description. */
  state: string;
  stateBasis: ClaimBasis;
  stateRule: string | null;
  /** Canonical facts hashed into the fingerprint. Only these define "changed". */
  stateFacts: Record<string, string>;
  /** When the source says this state took effect; used to reject stale data. */
  statePublishedAt: string | null;
  proceduralStage: string | null;
  nextExpectedStage: string | null;
  nextStageRule: string | null;
  significance: Significance;
  evidence: Evidence;
}

export interface Citation extends Evidence {
  id: string;
  /** Event whose ingestion produced this citation. */
  eventId: string;
  /** Time of the fetch that produced the cited bytes. */
  retrievedAt: string;
}

export interface Claim {
  eventId: string;
  field: ClaimField;
  value: string;
  basis: ClaimBasis;
  rule: string | null;
  /** Ordered; may reference citations of earlier events (previousState). */
  citationIds: string[];
}

export interface LegalEvent {
  id: string;
  kind: EventKind;
  stateKey: string;
  /** 0 for the first observation, +1 per recorded change. */
  revision: number;
  source: SourceId;
  domain: Domain;
  title: string;
  summary: string;
  actors: string[];
  instrument: string | null;
  action: string;
  previousState: string | null;
  previousFingerprint: string | null;
  previousStatePublishedAt: string | null;
  previousProceduralStage: string | null;
  newState: string;
  fingerprint: string;
  statePublishedAt: string | null;
  proceduralStage: string | null;
  nextExpectedStage: string | null;
  significance: Significance;
  observedAt: string;
}

export interface EventBundle {
  event: LegalEvent;
  claims: Claim[];
  /** Every citation referenced by `claims`, including earlier events' citations. */
  citations: Citation[];
}

export interface LegalObject {
  stateKey: string;
  source: SourceId;
  domain: Domain;
  title: string;
  instrument: string | null;
  currentState: string;
  fingerprint: string;
  revision: number;
  currentEventId: string;
  proceduralStage: string | null;
  statePublishedAt: string | null;
  firstSeenAt: string;
  lastChangedAt: string;
  lastObservedAt: string;
  observationCount: number;
}

/** What decide() needs to know about an object's present. */
export interface ObjectSnapshot {
  object: LegalObject;
  /** The newState claim of object.currentEventId. */
  stateClaim: Claim;
}

export type SegmentKind = "direction" | "narration";

export interface ScriptSegment {
  index: number;
  kind: SegmentKind;
  role: string;
  text: string;
  /** [start, end) character offsets into Briefing.script. */
  start: number;
  end: number;
  eventId: string | null;
  claimField: ClaimField | null;
  basis: ClaimBasis | "editorial";
  citationIds: string[];
  audioStart: number | null;
  audioEnd: number | null;
}

export type BroadcastMode =
  | "morning-docket"
  | "legislative-drift"
  | "enforcement-pulse"
  | "case-law"
  | "m-and-a"
  | "securities"
  | "what-changed";

export interface AudioAsset {
  filename: string;
  urlPath: string;
  sha256: string;
  byteLength: number;
  modelId: string;
  voiceId: string;
  outputFormat: string;
  chunks: number;
  /** aligned: every segment has audio offsets; partial: some; none: no alignment. */
  timing: "aligned" | "partial" | "none";
  durationSeconds: number | null;
}

export interface Briefing {
  id: string;
  mode: BroadcastMode;
  title: string;
  createdAt: string;
  /** Exclusive lower bound on event.observedAt; null = from the beginning. */
  windowStart: string | null;
  /** Inclusive upper bound on event.observedAt. */
  windowEnd: string;
  script: string;
  segments: ScriptSegment[];
  eventIds: string[];
  citationIds: string[];
  audio: AudioAsset | null;
}

export type RunStatus = "running" | "succeeded" | "partial" | "failed";

export interface SourceRunStats {
  source: SourceId;
  requests: number;
  documents: number;
  newDocuments: number;
  observations: number;
  created: number;
  transitioned: number;
  unchanged: number;
  stale: number;
  errors: string[];
}

export interface IngestReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  sources: SourceRunStats[];
}
