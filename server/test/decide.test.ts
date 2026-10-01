import { describe, expect, it } from "vitest";
import { decide, fingerprintOf, type Decision } from "../src/core/decide.js";
import type { ObjectSnapshot, Observation } from "../src/core/types.js";

const DOC_A = "a".repeat(64);
const DOC_B = "b".repeat(64);

function obs(over: Partial<Observation> = {}): Observation {
  return {
    source: "congress",
    domain: "legislation",
    kind: "stateful",
    stateKey: "congress:bill:119:hr:1",
    title: "Test Act",
    summary: "",
    actors: ["U.S. House"],
    instrument: "H.R. 1",
    action: "Referred to committee.",
    state: "Referred to committee.",
    stateBasis: "derived",
    stateRule: "congress.stage.referred",
    stateFacts: { actionText: "Referred to committee.", actionDate: "2026-09-01T00:00:00.000Z" },
    statePublishedAt: "2026-09-01T00:00:00.000Z",
    proceduralStage: "in committee",
    nextExpectedStage: "Committee vote",
    nextStageRule: "congress.stage.referred.next",
    significance: "routine",
    evidence: {
      documentId: DOC_A,
      locator: "/bills/0",
      url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
      title: "H.R. 1",
      publisher: "Congress.gov",
      excerpt: "H.R. 1: Referred to committee.",
      publishedAt: "2026-09-01T00:00:00.000Z"
    },
    ...over
  };
}

const ctx = (observedAt: string) => ({ observedAt, retrievedAt: observedAt });

function snapshotOf(d: Decision): ObjectSnapshot {
  if (d.type !== "created" && d.type !== "transitioned") throw new Error("no bundle");
  return { object: d.object, stateClaim: d.bundle.claims.find((c) => c.field === "newState")! };
}

const reported = obs({
  action: "Ordered to be reported.",
  state: "Reported by committee.",
  stateRule: "congress.stage.reported",
  stateFacts: { actionText: "Ordered to be reported.", actionDate: "2026-09-20T00:00:00.000Z" },
  statePublishedAt: "2026-09-20T00:00:00.000Z",
  proceduralStage: "reported by committee",
  significance: "notable",
  evidence: { ...obs().evidence, documentId: DOC_B, excerpt: "H.R. 1: Ordered to be reported." }
});

describe("decide()", () => {
  it("records a first stateful observation as a baseline, not a change", () => {
    const d = decide(null, obs(), ctx("2026-10-01T00:00:00.000Z"));
    expect(d.type).toBe("created");
    if (d.type !== "created") return;
    expect(d.bundle.event.kind).toBe("baseline");
    expect(d.bundle.event.revision).toBe(0);
    expect(d.bundle.event.previousState).toBeNull();
    expect(d.bundle.claims.every((c) => c.citationIds.length > 0)).toBe(true);
  });

  it("records a first occurrence as an occurrence", () => {
    const d = decide(null, obs({ kind: "occurrence" }), ctx("2026-10-01T00:00:00.000Z"));
    expect(d.type === "created" && d.bundle.event.kind).toBe("occurrence");
  });

  it("is a no-op (touch only) when the fingerprint is unchanged", () => {
    const first = decide(null, obs(), ctx("2026-10-01T00:00:00.000Z"));
    const again = decide(snapshotOf(first), obs({ title: "Retitled but same state" }), ctx("2026-10-02T00:00:00.000Z"));
    expect(again.type).toBe("unchanged");
    if (again.type !== "unchanged") return;
    expect(again.object.observationCount).toBe(2);
    expect(again.object.lastObservedAt).toBe("2026-10-02T00:00:00.000Z");
    expect(again.object.lastChangedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("emits a transition whose previous-state claim cites the earlier document", () => {
    const first = decide(null, obs(), ctx("2026-10-01T00:00:00.000Z"));
    const firstCitation = first.type === "created" ? first.bundle.citations[0]! : null;
    const d = decide(snapshotOf(first), reported, ctx("2026-10-02T00:00:00.000Z"));
    expect(d.type).toBe("transitioned");
    if (d.type !== "transitioned") return;

    const { event, claims, citations } = d.bundle;
    expect(event.kind).toBe("transition");
    expect(event.revision).toBe(1);
    expect(event.previousState).toBe("Referred to committee.");
    expect(event.previousProceduralStage).toBe("in committee");

    const byField = Object.fromEntries(claims.map((c) => [c.field, c]));
    expect(byField.previousState!.citationIds).toEqual([firstCitation!.id]);
    expect(byField.previousState!.basis).toBe("derived");
    expect(byField.newState!.citationIds).toEqual([citations[0]!.id]);
    expect(citations[0]!.documentId).toBe(DOC_B);
    expect(byField.difference!.value).toBe("Procedural stage moved from in committee to reported by committee.");
    expect(byField.difference!.citationIds).toEqual([firstCitation!.id, citations[0]!.id]);
    expect(byField.nextExpectedStage!.basis).toBe("inferred");
  });

  it("rejects observations older than the stored state (no flapping)", () => {
    const first = decide(null, reported, ctx("2026-10-01T00:00:00.000Z"));
    const d = decide(snapshotOf(first), obs(), ctx("2026-10-02T00:00:00.000Z"));
    expect(d.type).toBe("stale");
  });

  it("derives deterministic ids that differ across revisions even if a state recurs", () => {
    const a1 = decide(null, obs(), ctx("2026-10-01T00:00:00.000Z"));
    const a2 = decide(null, obs(), ctx("2026-10-05T00:00:00.000Z"));
    expect(a1.type === "created" && a2.type === "created" && a1.bundle.event.id === a2.bundle.event.id).toBe(true);

    const b = decide(snapshotOf(a1), reported, ctx("2026-10-02T00:00:00.000Z"));
    const back = decide(snapshotOf(b), obs({ statePublishedAt: "2026-09-25T00:00:00.000Z" }), ctx("2026-10-03T00:00:00.000Z"));
    expect(back.type).toBe("transitioned");
    if (back.type !== "transitioned" || a1.type !== "created") return;
    expect(back.bundle.event.fingerprint).toBe(a1.bundle.event.fingerprint);
    expect(back.bundle.event.id).not.toBe(a1.bundle.event.id);
  });

  it("fingerprints are key-order independent", () => {
    expect(fingerprintOf({ a: "1", b: "2" })).toBe(fingerprintOf({ b: "2", a: "1" }));
  });
});
