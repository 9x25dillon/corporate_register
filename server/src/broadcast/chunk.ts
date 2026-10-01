import type { ScriptSegment } from "../core/types.js";
import { SEGMENT_SEPARATOR } from "./compiler.js";

export interface ChunkEntry {
  segmentIndex: number;
  /** [localStart, localEnd) offsets within the chunk text. */
  localStart: number;
  localEnd: number;
}

export interface Chunk {
  text: string;
  entries: ChunkEntry[];
}

/** Character-level alignment as returned by ElevenLabs /with-timestamps. */
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Split a compiled script into TTS requests of at most maxChars.
 *
 * - Splits only between items (an item starts at its "item-label" segment, and
 *   the closing starts its own group), falling back to segment boundaries for
 *   oversized items; segments are never cut.
 * - Every chunk after the first is prefixed with the delivery direction, because
 *   a fresh request does not inherit the previous request's voice direction.
 */
export function planChunks(segments: readonly ScriptSegment[], maxChars: number): Chunk[] {
  const delivery = segments[0];
  if (!delivery || delivery.role !== "delivery") throw new Error("script must begin with a delivery direction");

  const groups: ScriptSegment[][] = [];
  for (const seg of segments.slice(1)) {
    const last = groups.at(-1);
    if (last === undefined) {
      groups.push([seg]);
    } else if (seg.role === "item-label" || seg.role === "closing") {
      // Pauses that introduce an item travel with it.
      const lead = takeTrailingPauses(last);
      if (last.length === 0) groups.pop();
      groups.push([...lead, seg]);
    } else {
      last.push(seg);
    }
  }

  const chunks: Chunk[] = [];
  let current = newChunk(delivery);
  const budget = (extra: string) => current.text.length + SEGMENT_SEPARATOR.length + extra.length;

  const flush = () => {
    if (current.entries.some((e) => e.segmentIndex !== delivery.index)) chunks.push(current);
    current = newChunk(delivery, false);
  };

  for (const group of groups) {
    const groupText = group.map((s) => s.text).join(SEGMENT_SEPARATOR);
    if (budget(groupText) > maxChars && hasContent(current, delivery)) flush();
    for (const seg of group) {
      if (budget(seg.text) > maxChars && hasContent(current, delivery)) flush();
      if (budget(seg.text) > maxChars) {
        throw new Error(`segment ${seg.index} (${seg.text.length} chars) cannot fit in a ${maxChars}-char request`);
      }
      append(current, seg);
    }
  }
  flush();
  return chunks;
}

function newChunk(delivery: ScriptSegment, includeInManifest = true): Chunk {
  return {
    text: delivery.text,
    entries: includeInManifest ? [{ segmentIndex: delivery.index, localStart: 0, localEnd: delivery.text.length }] : []
  };
}

function append(chunk: Chunk, seg: ScriptSegment): void {
  const localStart = chunk.text.length + SEGMENT_SEPARATOR.length;
  chunk.text += SEGMENT_SEPARATOR + seg.text;
  chunk.entries.push({ segmentIndex: seg.index, localStart, localEnd: localStart + seg.text.length });
}

function hasContent(chunk: Chunk, delivery: ScriptSegment): boolean {
  return chunk.entries.some((e) => e.segmentIndex !== delivery.index);
}

function isTrailingPause(group: ScriptSegment[]): boolean {
  return group.length > 0 && group[group.length - 1]!.role === "pause";
}

function takeTrailingPauses(group: ScriptSegment[]): ScriptSegment[] {
  const out: ScriptSegment[] = [];
  while (isTrailingPause(group)) out.unshift(group.pop()!);
  return out;
}

export interface TimingResult {
  segments: ScriptSegment[];
  timing: "aligned" | "partial" | "none";
  durationSeconds: number | null;
}

/**
 * Map per-chunk character alignments onto script segments.
 * Chunk k's clock starts where chunk k-1's last character ended. If a chunk's
 * alignment is missing or does not reproduce its text exactly, offsets for it
 * and every later chunk are unknown and left null (never guessed).
 */
export function applyTiming(
  segments: readonly ScriptSegment[],
  chunks: readonly Chunk[],
  alignments: readonly (Alignment | null)[]
): TimingResult {
  const out = segments.map((s) => ({ ...s, audioStart: null as number | null, audioEnd: null as number | null }));
  let offset = 0;
  let alignedChunks = 0;

  for (const [k, chunk] of chunks.entries()) {
    const a = alignments[k] ?? null;
    if (!isExactAlignment(a, chunk.text)) break;
    for (const entry of chunk.entries) {
      const seg = out[entry.segmentIndex]!;
      seg.audioStart = round(offset + a.character_start_times_seconds[entry.localStart]!);
      seg.audioEnd = round(offset + a.character_end_times_seconds[entry.localEnd - 1]!);
    }
    offset += Math.max(0, ...a.character_end_times_seconds);
    alignedChunks++;
  }

  const timing = alignedChunks === 0 ? "none" : alignedChunks === chunks.length ? "aligned" : "partial";
  return { segments: out, timing, durationSeconds: timing === "aligned" ? round(offset) : null };
}

function isExactAlignment(a: Alignment | null, text: string): a is Alignment {
  return (
    a !== null &&
    a.characters.length === text.length &&
    a.character_start_times_seconds.length === text.length &&
    a.character_end_times_seconds.length === text.length &&
    a.characters.join("") === text
  );
}

const round = (s: number) => Math.round(s * 1000) / 1000;
