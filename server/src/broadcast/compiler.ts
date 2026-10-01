import type { Claim, ClaimField, EventBundle, LegalEvent, ScriptSegment, Significance } from "../core/types.js";
import { MODES, PAUSE } from "./modes.js";
import { numberWord, SOURCE_LABEL, speakable, spokenCount, spokenDate } from "./speech.js";

/** Separator between segments in the compiled script. v4 reads blank lines as phrasing breaks. */
export const SEGMENT_SEPARATOR = "\n\n";

export interface CompiledScript {
  title: string;
  script: string;
  segments: ScriptSegment[];
  eventIds: string[];
  citationIds: string[];
}

type SegmentInput = Omit<ScriptSegment, "index" | "start" | "end" | "audioStart" | "audioEnd">;

/** Accumulates segments while maintaining exact character offsets into the script. */
export class ScriptBuilder {
  private readonly segments: ScriptSegment[] = [];
  private cursor = 0;

  add(input: SegmentInput): void {
    if (input.text.length === 0) return;
    if (this.segments.length > 0) this.cursor += SEGMENT_SEPARATOR.length;
    const start = this.cursor;
    this.cursor += input.text.length;
    this.segments.push({ ...input, index: this.segments.length, start, end: this.cursor, audioStart: null, audioEnd: null });
  }

  direction(role: string, text: string): void {
    this.add({ kind: "direction", role, text, eventId: null, claimField: null, basis: "editorial", citationIds: [] });
  }

  editorial(role: string, text: string): void {
    this.add({ kind: "narration", role, text, eventId: null, claimField: null, basis: "editorial", citationIds: [] });
  }

  claim(role: string, text: string, claim: Claim): void {
    this.add({
      kind: "narration",
      role,
      text,
      eventId: claim.eventId,
      claimField: claim.field,
      basis: claim.basis,
      citationIds: [...claim.citationIds]
    });
  }

  build(): { script: string; segments: ScriptSegment[] } {
    return { script: this.segments.map((s) => s.text).join(SEGMENT_SEPARATOR), segments: this.segments };
  }
}

const SIGNIFICANCE_RANK: Record<Significance, number> = { major: 3, notable: 2, routine: 1 };

/** Deterministic editorial order: significance, then recency of the source state, then id. */
export function rankEvents<T extends LegalEvent>(events: readonly T[]): T[] {
  const time = (e: LegalEvent) => Date.parse(e.statePublishedAt ?? e.observedAt);
  return [...events].sort(
    (a, b) =>
      SIGNIFICANCE_RANK[b.significance] - SIGNIFICANCE_RANK[a.significance] ||
      time(b) - time(a) ||
      a.id.localeCompare(b.id)
  );
}

export interface WhatChangedInput {
  /** Already ranked and limited. Baselines are rejected. */
  bundles: readonly EventBundle[];
  windowStart: string | null;
  /** Total eligible changes in the window before the limit was applied. */
  totalInWindow: number;
}

/**
 * Compile the What Changed? broadcast.
 *
 * Per change:   label → previous state → trigger → new state → difference → next trigger
 * Per new item: label → "no previously recorded state" → trigger → new state
 *
 * Every narration segment that states a fact about an event is emitted from a
 * Claim and therefore carries that claim's citations (sentence-level manifest).
 * Events lacking a required claim are skipped, never narrated without support.
 */
export function compileWhatChanged(input: WhatChangedInput): CompiledScript {
  const mode = MODES["what-changed"];
  const b = new ScriptBuilder();
  const usable = input.bundles.filter((bundle) => isNarratable(bundle));

  b.direction("delivery", mode.delivery);
  b.editorial("opening", mode.opening);
  b.direction("pause", PAUSE.brief);

  const since = spokenDate(input.windowStart);
  if (usable.length === 0) {
    b.editorial("summary", since ? `No recorded changes since ${since}.` : "No recorded changes yet.");
  } else {
    const head = `${spokenCount(input.totalInWindow, "change")}${since ? ` since ${since}` : ""}.`;
    const shown = usable.length;
    const tail =
      shown >= input.totalInWindow ? "" : shown === 1 ? " The most significant follows." : ` The ${numberWord(shown)} most significant follow.`;
    b.editorial("summary", `${head}${tail}`);
  }

  usable.forEach((bundle, i) => {
    b.direction("pause", PAUSE.long);
    emitItem(b, bundle, i + 1);
  });

  b.direction("pause", PAUSE.long);
  b.editorial("closing", mode.closing);

  const { script, segments } = b.build();
  return {
    title: mode.title,
    script,
    segments,
    eventIds: usable.map((u) => u.event.id),
    citationIds: [...new Set(segments.flatMap((s) => s.citationIds))]
  };
}

function claimOf(bundle: EventBundle, field: ClaimField): Claim | undefined {
  return bundle.claims.find((c) => c.field === field && c.citationIds.length > 0);
}

function isNarratable(bundle: EventBundle): boolean {
  const { kind } = bundle.event;
  if (kind === "baseline") return false;
  if (!claimOf(bundle, "newState") || !claimOf(bundle, "action")) return false;
  return kind === "occurrence" || claimOf(bundle, "previousState") !== undefined;
}

function emitItem(b: ScriptBuilder, bundle: EventBundle, n: number): void {
  const e = bundle.event;
  const newState = claimOf(bundle, "newState")!;
  const action = claimOf(bundle, "action")!;

  const label = e.kind === "transition" ? `Item ${n}. ${SOURCE_LABEL[e.source]}. ${speakable(e.title, 200)}` : `Item ${n}. ${SOURCE_LABEL[e.source]}.`;
  b.claim("item-label", label, newState);
  b.direction("pause", PAUSE.brief);

  if (e.kind === "transition") {
    const previous = claimOf(bundle, "previousState")!;
    const asOf = spokenDate(e.previousStatePublishedAt);
    b.claim("previous-state", `Previous state${asOf ? `, as of ${asOf}` : ""}.\n${speakable(previous.value)}`, previous);
  } else {
    b.claim("previous-state", "New matter. No previously recorded state.", { ...newState, basis: "derived" });
  }
  b.direction("pause", PAUSE.brief);

  const dated = spokenDate(e.statePublishedAt);
  b.claim("trigger", `Trigger${dated ? `, ${dated}` : ""}.\n${speakable(action.value)}`, action);
  b.direction("pause", PAUSE.brief);
  b.claim("new-state", `New state.\n${speakable(newState.value)}`, newState);

  const difference = claimOf(bundle, "difference");
  if (difference) {
    b.direction("pause", PAUSE.brief);
    b.claim("difference", `Difference.\n${speakable(difference.value)}`, difference);
  }
  const next = claimOf(bundle, "nextExpectedStage");
  if (next) {
    b.direction("pause", PAUSE.brief);
    b.claim("next-trigger", `Next observable trigger.\n${speakable(next.value)}`, next);
  }
}
