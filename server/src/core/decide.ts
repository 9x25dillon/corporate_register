import { canonicalJson, deriveId, sha256 } from "../util/hash.js";
import { isStrictlyBefore } from "../util/time.js";
import type {
  Citation,
  Claim,
  EventBundle,
  LegalEvent,
  LegalObject,
  ObjectSnapshot,
  Observation
} from "./types.js";

/**
 * The state-transition function of the ledger. Pure: no I/O, no clock.
 *
 *            ┌──────────── snapshot == null ────────────┐
 *            │                                          ▼
 *   obs ─────┤                                 created (baseline | occurrence)
 *            │  fingerprint equal ──────────► unchanged (touch lastObservedAt)
 *            └─ fingerprint differs ─┬─ obs older than stored state ─► stale
 *                                    └─ otherwise ──────────────────► transitioned
 *
 * Invariants guaranteed for every emitted EventBundle:
 *   I1  every claim has ≥1 citation id;
 *   I2  every citation id in claims resolves within bundle.citations
 *       or snapshot.stateClaim.citationIds (previous-state provenance);
 *   I3  event.revision == previous revision + 1 (0 for new objects);
 *   I4  ids are deterministic functions of (stateKey, revision, fingerprint).
 */
export type Decision =
  | { type: "unchanged"; stateKey: string; object: LegalObject }
  | { type: "stale"; stateKey: string; reason: string }
  | { type: "created" | "transitioned"; stateKey: string; bundle: EventBundle; object: LegalObject };

export interface DecideContext {
  /** When the ledger observed this (ingestion clock). */
  observedAt: string;
  /** When the cited bytes were fetched. */
  retrievedAt: string;
}

export function fingerprintOf(stateFacts: Record<string, string>): string {
  return sha256(canonicalJson(stateFacts)).slice(0, 32);
}

export function decide(snapshot: ObjectSnapshot | null, obs: Observation, ctx: DecideContext): Decision {
  const fingerprint = fingerprintOf(obs.stateFacts);
  const prev = snapshot?.object ?? null;

  if (prev !== null) {
    if (prev.stateKey !== obs.stateKey) {
      throw new Error(`snapshot ${prev.stateKey} does not match observation ${obs.stateKey}`);
    }
    if (prev.fingerprint === fingerprint) {
      return {
        type: "unchanged",
        stateKey: obs.stateKey,
        object: { ...prev, lastObservedAt: ctx.observedAt, observationCount: prev.observationCount + 1 }
      };
    }
    if (isStrictlyBefore(obs.statePublishedAt, prev.statePublishedAt)) {
      return {
        type: "stale",
        stateKey: obs.stateKey,
        reason: `observed state dated ${obs.statePublishedAt} predates stored state dated ${prev.statePublishedAt}`
      };
    }
  }

  const revision = prev === null ? 0 : prev.revision + 1;
  const kind: LegalEvent["kind"] = prev !== null ? "transition" : obs.kind === "occurrence" ? "occurrence" : "baseline";
  const eventId = deriveId("event", obs.stateKey, String(revision), fingerprint);

  const citation: Citation = {
    ...obs.evidence,
    id: deriveId("citation", eventId, obs.evidence.documentId, obs.evidence.locator),
    eventId,
    retrievedAt: ctx.retrievedAt
  };
  const cite = [citation.id];

  const event: LegalEvent = {
    id: eventId,
    kind,
    stateKey: obs.stateKey,
    revision,
    source: obs.source,
    domain: obs.domain,
    title: obs.title,
    summary: obs.summary,
    actors: [...obs.actors],
    instrument: obs.instrument,
    action: obs.action,
    previousState: prev?.currentState ?? null,
    previousFingerprint: prev?.fingerprint ?? null,
    previousStatePublishedAt: prev?.statePublishedAt ?? null,
    previousProceduralStage: prev?.proceduralStage ?? null,
    newState: obs.state,
    fingerprint,
    statePublishedAt: obs.statePublishedAt,
    proceduralStage: obs.proceduralStage,
    nextExpectedStage: obs.nextExpectedStage,
    significance: obs.significance,
    observedAt: ctx.observedAt
  };

  const claims: Claim[] = [
    claim(eventId, "newState", obs.state, obs.stateBasis, obs.stateRule, cite),
    claim(eventId, "action", obs.action, "source", null, cite)
  ];

  if (snapshot !== null) {
    const previousCitations = snapshot.stateClaim.citationIds;
    const { value, basis, rule } = snapshot.stateClaim;
    claims.push(claim(eventId, "previousState", value, basis, rule, previousCitations));
    const difference = describeStageDifference(prev?.proceduralStage ?? null, obs.proceduralStage);
    if (difference !== null) {
      claims.push(claim(eventId, "difference", difference, "derived", "stage-diff", [...previousCitations, ...cite]));
    }
  }
  if (obs.nextExpectedStage !== null) {
    claims.push(claim(eventId, "nextExpectedStage", obs.nextExpectedStage, "inferred", obs.nextStageRule, cite));
  }

  for (const c of claims) {
    if (c.citationIds.length === 0) throw new Error(`invariant I1 violated: ${obs.stateKey} claim ${c.field} has no citation`);
  }

  const object: LegalObject = {
    stateKey: obs.stateKey,
    source: obs.source,
    domain: obs.domain,
    title: obs.title,
    instrument: obs.instrument,
    currentState: obs.state,
    fingerprint,
    revision,
    currentEventId: eventId,
    proceduralStage: obs.proceduralStage,
    statePublishedAt: obs.statePublishedAt,
    firstSeenAt: prev?.firstSeenAt ?? ctx.observedAt,
    lastChangedAt: ctx.observedAt,
    lastObservedAt: ctx.observedAt,
    observationCount: (prev?.observationCount ?? 0) + 1
  };

  return {
    type: prev === null ? "created" : "transitioned",
    stateKey: obs.stateKey,
    bundle: { event, claims, citations: [citation] },
    object
  };
}

function claim(
  eventId: string,
  field: Claim["field"],
  value: string,
  basis: Claim["basis"],
  rule: string | null,
  citationIds: string[]
): Claim {
  return { eventId, field, value, basis, rule, citationIds: [...new Set(citationIds)] };
}

export function describeStageDifference(previous: string | null, next: string | null): string | null {
  if (previous === null || next === null) return null;
  if (previous === next) return `Procedural stage unchanged: ${previous}.`;
  return `Procedural stage moved from ${previous} to ${next}.`;
}
