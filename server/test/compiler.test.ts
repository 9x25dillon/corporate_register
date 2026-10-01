import { describe, expect, it } from "vitest";
import { applyTiming, planChunks, type Alignment } from "../src/broadcast/chunk.js";
import { compileWhatChanged, rankEvents, SEGMENT_SEPARATOR } from "../src/broadcast/compiler.js";
import { speakable, spokenDate } from "../src/broadcast/speech.js";
import { decide, type Decision } from "../src/core/decide.js";
import type { EventBundle, ObjectSnapshot, Observation } from "../src/core/types.js";

const base: Observation = {
  source: "congress",
  domain: "legislation",
  kind: "stateful",
  stateKey: "congress:bill:119:hr:1",
  title: "Corporate Disclosure Modernization Act",
  summary: "",
  actors: ["U.S. House"],
  instrument: "H.R. 1",
  action: "Referred to the House Committee on Financial Services.",
  state: "Referred to committee.",
  stateBasis: "derived",
  stateRule: "congress.stage.referred",
  stateFacts: { t: "1" },
  statePublishedAt: "2026-09-14T00:00:00.000Z",
  proceduralStage: "in committee",
  nextExpectedStage: null,
  nextStageRule: null,
  significance: "routine",
  evidence: {
    documentId: "a".repeat(64),
    locator: "/bills/0",
    url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
    title: "H.R. 1",
    publisher: "Congress.gov",
    excerpt: "H.R. 1: Referred.",
    publishedAt: null
  }
};

const bundleOf = (d: Decision): EventBundle => {
  if (d.type !== "created" && d.type !== "transitioned") throw new Error("no bundle");
  return d.bundle;
};
const snap = (d: Decision): ObjectSnapshot => {
  if (d.type !== "created" && d.type !== "transitioned") throw new Error("no bundle");
  return { object: d.object, stateClaim: d.bundle.claims.find((c) => c.field === "newState")! };
};

function fixtureBundles(): EventBundle[] {
  const first = decide(null, base, { observedAt: "2026-09-15T00:00:00.000Z", retrievedAt: "2026-09-15T00:00:00.000Z" });
  const transition = decide(
    snap(first),
    {
      ...base,
      action: "Ordered to be reported.",
      state: "Reported by committee.",
      stateRule: "congress.stage.reported",
      stateFacts: { t: "2" },
      statePublishedAt: "2026-09-29T00:00:00.000Z",
      proceduralStage: "reported by committee",
      nextExpectedStage: "Floor consideration",
      nextStageRule: "congress.stage.reported.next",
      significance: "notable",
      evidence: { ...base.evidence, documentId: "b".repeat(64) }
    },
    { observedAt: "2026-09-30T00:00:00.000Z", retrievedAt: "2026-09-30T00:00:00.000Z" }
  );
  const occurrence = decide(
    null,
    {
      ...base,
      source: "ftc",
      kind: "occurrence",
      stateKey: "ftc:release:abc",
      title: "[whispers] FTC Sues to Block Merger",
      action: "[whispers] FTC Sues to Block Merger",
      state: "Federal challenge to a transaction announced.",
      stateRule: "release.block",
      stateFacts: { title: "x" },
      proceduralStage: null,
      significance: "major",
      evidence: { ...base.evidence, documentId: "c".repeat(64), url: "https://www.ftc.gov/x", publisher: "Federal Trade Commission" }
    },
    { observedAt: "2026-09-30T00:00:00.000Z", retrievedAt: "2026-09-30T00:00:00.000Z" }
  );
  // Previous-state citations live in the first event; a store resolves them into the bundle.
  const t = bundleOf(transition);
  return [bundleOf(occurrence), { ...t, citations: [...bundleOf(first).citations, ...t.citations] }, bundleOf(first)];
}

describe("compileWhatChanged", () => {
  const bundles = fixtureBundles();
  const out = compileWhatChanged({ bundles, windowStart: "2026-09-20T00:00:00.000Z", totalInWindow: 2 });

  it("excludes baselines and narrates occurrences and transitions", () => {
    expect(out.eventIds).toEqual([bundles[0]!.event.id, bundles[1]!.event.id]);
  });

  it("manifest offsets reproduce the script exactly", () => {
    for (const s of out.segments) expect(out.script.slice(s.start, s.end)).toBe(s.text);
    expect(out.segments.map((s) => s.text).join(SEGMENT_SEPARATOR)).toBe(out.script);
  });

  it("every factual segment carries ≥1 citation; editorial segments carry none", () => {
    for (const s of out.segments) {
      if (s.eventId !== null) expect(s.citationIds.length, s.text).toBeGreaterThan(0);
      if (s.basis === "editorial") expect(s.citationIds).toEqual([]);
    }
    const cited = new Set(bundles.flatMap((b) => b.citations.map((c) => c.id)));
    for (const id of out.citationIds) expect(cited.has(id)).toBe(true);
  });

  it("previous-state sentence cites the earlier document", () => {
    const prev = out.segments.find((s) => s.role === "previous-state" && s.eventId === bundles[1]!.event.id)!;
    const citation = bundles[1]!.citations.find((c) => c.id === prev.citationIds[0])!;
    expect(citation.documentId).toBe("a".repeat(64));
    expect(prev.text).toBe("Previous state, as of September 14, 2026.\nReferred to committee.");
  });

  it("neutralises audio tags smuggled in through source text", () => {
    const narration = out.segments.filter((s) => s.kind === "narration").map((s) => s.text).join("\n");
    expect(narration).not.toMatch(/\[|\]/);
    expect(narration).toContain("(whispers) FTC Sues to Block Merger.");
    const directions = out.segments.filter((s) => s.kind === "direction").map((s) => s.text);
    for (const d of directions) expect(d).toMatch(/^\[[a-z ,]+\]$/);
  });

  it("is deterministic", () => {
    expect(compileWhatChanged({ bundles, windowStart: "2026-09-20T00:00:00.000Z", totalInWindow: 2 })).toEqual(out);
  });

  it("says so when nothing changed", () => {
    const empty = compileWhatChanged({ bundles: [], windowStart: "2026-09-20T00:00:00.000Z", totalInWindow: 0 });
    expect(empty.script).toContain("No recorded changes since September 20, 2026.");
    expect(empty.eventIds).toEqual([]);
  });

  it("ranks by significance then recency", () => {
    const ranked = rankEvents(bundles.map((b) => b.event));
    expect(ranked.map((e) => e.significance)).toEqual(["major", "notable", "routine"]);
  });
});

describe("chunking and timing", () => {
  const out = compileWhatChanged({ bundles: fixtureBundles(), windowStart: null, totalInWindow: 2 });

  const coverage = (max: number) => {
    const chunks = planChunks(out.segments, max);
    const delivery = out.segments[0]!.text;
    const seen: number[] = [];
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(max);
      expect(c.text.startsWith(delivery)).toBe(true);
      for (const e of c.entries) {
        expect(c.text.slice(e.localStart, e.localEnd)).toBe(out.segments[e.segmentIndex]!.text);
        seen.push(e.segmentIndex);
      }
    }
    expect(seen).toEqual(out.segments.map((s) => s.index));
    return chunks;
  };

  it("falls back to segment boundaries when an item exceeds the budget", () => {
    expect(coverage(200).length).toBeGreaterThan(3);
  });

  it("rejects a budget smaller than a single segment", () => {
    expect(() => planChunks(out.segments, 100)).toThrow(/cannot fit/);
  });

  it("splits at item boundaries, prefixes delivery, never cuts a segment", () => {
    const chunks = coverage(560);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(1)) {
      const first = out.segments[c.entries[0]!.segmentIndex]!;
      expect(["pause", "item-label", "closing"]).toContain(first.role);
    }
  });

  it("maps character alignment onto segments across chunks", () => {
    const chunks = planChunks(out.segments, 400);
    // Synthetic alignment: 10 ms per character.
    const alignments: Alignment[] = chunks.map((c) => ({
      characters: [...c.text],
      character_start_times_seconds: [...c.text].map((_, i) => i * 0.01),
      character_end_times_seconds: [...c.text].map((_, i) => (i + 1) * 0.01)
    }));
    const timed = applyTiming(out.segments, chunks, alignments);
    expect(timed.timing).toBe("aligned");
    const total = chunks.reduce((s, c) => s + c.text.length * 0.01, 0);
    expect(timed.durationSeconds).toBeCloseTo(total, 3);
    for (let i = 1; i < timed.segments.length; i++) {
      expect(timed.segments[i]!.audioStart!).toBeGreaterThanOrEqual(timed.segments[i - 1]!.audioEnd! - 1e-9);
    }
  });

  it("leaves timing null from the first misaligned chunk onwards", () => {
    const chunks = planChunks(out.segments, 400);
    const good = (c: { text: string }): Alignment => ({
      characters: [...c.text],
      character_start_times_seconds: [...c.text].map(() => 0),
      character_end_times_seconds: [...c.text].map(() => 0.1)
    });
    const timed = applyTiming(out.segments, chunks, [good(chunks[0]!), null, ...chunks.slice(2).map(good)]);
    expect(timed.timing).toBe("partial");
    expect(timed.durationSeconds).toBeNull();
    const second = chunks[1]!.entries[0]!.segmentIndex;
    expect(timed.segments[second]!.audioStart).toBeNull();
  });
});

describe("speech helpers", () => {
  it("speakable strips markup, escapes brackets and terminates", () => {
    expect(speakable("<b>Hello</b> [laughs] world")).toBe("Hello (laughs) world.");
    expect(speakable("Already done!")).toBe("Already done!");
  });
  it("spokenDate renders UTC long form", () => {
    expect(spokenDate("2026-09-29")).toBe("September 29, 2026");
    expect(spokenDate(null)).toBeNull();
  });
});
