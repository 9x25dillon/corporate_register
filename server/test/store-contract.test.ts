import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { decide, type Decision } from "../src/core/decide.js";
import type { Briefing, Observation, SourceDocument } from "../src/core/types.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/store.js";
import { sha256 } from "../src/util/hash.js";

const PG_URL = process.env.TEST_DATABASE_URL;

async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema if exists public cascade; create schema public;");
  await client.end();
}

const factories: [string, () => Promise<Store>][] = [["memory", async () => new MemoryStore()]];
if (PG_URL) {
  factories.push([
    "postgres",
    async () => {
      await resetDatabase(PG_URL);
      return new PostgresStore({ connectionString: PG_URL, poolMax: 8 });
    }
  ]);
}

function doc(body: string, fetchedAt = "2026-10-01T00:00:00.000Z"): SourceDocument {
  const bytes = Buffer.from(body);
  return { id: sha256(bytes), source: "congress", url: "https://api.congress.gov/v3/bill", contentType: "application/json", byteLength: bytes.length, fetchedAt, body: bytes };
}

function obs(documentId: string, n: number, over: Partial<Observation> = {}): Observation {
  return {
    source: "congress",
    domain: "legislation",
    kind: "stateful",
    stateKey: "congress:bill:119:hr:7",
    title: "Contract Test Act",
    summary: "",
    actors: ["U.S. House"],
    instrument: "H.R. 7",
    action: `Action ${n}.`,
    state: `State ${n}.`,
    stateBasis: "source",
    stateRule: null,
    stateFacts: { n: String(n) },
    statePublishedAt: new Date(Date.UTC(2026, 8, 1 + n)).toISOString(),
    proceduralStage: `stage ${n}`,
    nextExpectedStage: null,
    nextStageRule: null,
    significance: "notable",
    evidence: {
      documentId,
      locator: "/bills/0",
      url: "https://www.congress.gov/bill/119th-congress/house-bill/7",
      title: "H.R. 7",
      publisher: "Congress.gov",
      excerpt: `excerpt ${n}`,
      publishedAt: null
    },
    ...over
  };
}

const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();
const applyObs = (store: Store, o: Observation, observedAt: string): Promise<Decision> =>
  store.apply(o.stateKey, (s) => decide(s, o, { observedAt, retrievedAt: observedAt }));

for (const [name, make] of factories) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    const open: Store[] = [];

    beforeEach(async () => {
      store = await make();
      await store.init();
      open.push(store);
    });
    afterAll(async () => {
      for (const s of open) await s.close().catch(() => undefined);
    });

    it("stores documents content-addressed and idempotently; bytes round-trip", async () => {
      const d = doc('{"bills":[]}');
      expect(await store.putDocument(d)).toEqual({ inserted: true });
      expect(await store.putDocument({ ...d, fetchedAt: "2027-01-01T00:00:00.000Z" })).toEqual({ inserted: false });
      const back = await store.getDocument(d.id);
      expect(back!.body.equals(d.body)).toBe(true);
      expect(back!.fetchedAt).toBe(d.fetchedAt);
    });

    it("runs the created → unchanged → transitioned → stale lifecycle atomically", async () => {
      const d1 = doc("one");
      const d2 = doc("two");
      await store.putDocument(d1);
      await store.putDocument(d2);

      expect((await applyObs(store, obs(d1.id, 1), at(1))).type).toBe("created");
      expect((await applyObs(store, obs(d1.id, 1), at(2))).type).toBe("unchanged");
      const t = await applyObs(store, obs(d2.id, 2), at(3));
      expect(t.type).toBe("transitioned");
      expect((await applyObs(store, obs(d1.id, 0), at(4))).type).toBe("stale");

      const object = await store.getObject("congress:bill:119:hr:7");
      expect(object).toMatchObject({ revision: 1, currentState: "State 2.", observationCount: 3, lastObservedAt: at(3), firstSeenAt: at(1) });

      const history = await store.objectHistory("congress:bill:119:hr:7");
      expect(history.map((e) => [e.revision, e.kind])).toEqual([[0, "baseline"], [1, "transition"]]);

      const [bundle] = await store.getBundles([history[1]!.id]);
      const prev = bundle!.claims.find((c) => c.field === "previousState")!;
      const prevCitation = bundle!.citations.find((c) => c.id === prev.citationIds[0])!;
      expect(prevCitation.documentId).toBe(d1.id);
      expect(prevCitation.eventId).toBe(history[0]!.id);
      expect(bundle!.claims.map((c) => c.field)).toEqual(["newState", "previousState", "action", "difference"]);
    });

    it("serialises concurrent writers of one object: contiguous revisions, no lost updates", async () => {
      const d = doc("concurrent");
      await store.putDocument(d);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => applyObs(store, obs(d.id, i + 1, { statePublishedAt: null }), at(1)))
      );
      expect(results.filter((r) => r.type === "created")).toHaveLength(1);
      expect(results.filter((r) => r.type === "transitioned")).toHaveLength(11);
      const history = await store.objectHistory("congress:bill:119:hr:7");
      expect(history.map((e) => e.revision)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.previousFingerprint).toBe(history[i - 1]!.fingerprint);
      }
    });

    it("lists events by window: since exclusive, until inclusive, newest first", async () => {
      const d = doc("window");
      await store.putDocument(d);
      for (let i = 1; i <= 4; i++) {
        await applyObs(store, obs(d.id, i, { stateKey: `congress:bill:119:hr:${100 + i}` }), at(i));
      }
      const events = await store.listEvents({ since: at(1), until: at(3), limit: 10 });
      expect(events.map((e) => e.observedAt)).toEqual([at(3), at(2)]);
      expect(await store.listEvents({ kinds: ["transition"], limit: 10 })).toEqual([]);
      expect((await store.listEvents({ limit: 2 })).length).toBe(2);
    });

    it("rejects citations to unknown documents", async () => {
      await expect(applyObs(store, obs("f".repeat(64), 1), at(1))).rejects.toThrow();
      expect(await store.getObject("congress:bill:119:hr:7")).toBeNull();
    });

    it("grants the ingest lock to one holder at a time", async () => {
      let inner: unknown;
      const outer = await store.withIngestLock(async () => {
        inner = await store.withIngestLock(async () => "nested");
        return "outer";
      });
      expect(outer).toEqual({ acquired: true, value: "outer" });
      expect(inner).toEqual({ acquired: false });
      expect(await store.withIngestLock(async () => 1)).toEqual({ acquired: true, value: 1 });
    });

    it("persists briefings and returns the latest per mode", async () => {
      const b = (id: string, createdAt: string): Briefing => ({
        id,
        mode: "what-changed",
        title: "What Changed?",
        createdAt,
        windowStart: null,
        windowEnd: createdAt,
        script: "x",
        segments: [],
        eventIds: [],
        citationIds: [],
        audio: null
      });
      await store.putBriefing(b("1".repeat(32), at(1)));
      await store.putBriefing(b("2".repeat(32), at(2)));
      expect((await store.latestBriefing("what-changed"))!.id).toBe("2".repeat(32));
      expect((await store.getBriefing("1".repeat(32)))!.windowEnd).toBe(at(1));
    });

    it("records ingest runs and fetches", async () => {
      await store.beginRun("run-1", at(1));
      const d = doc("fetched");
      await store.putDocument(d);
      await store.putFetch({ id: "f1", runId: "run-1", source: "congress", url: d.url, startedAt: at(1), finishedAt: at(1), httpStatus: 200, documentId: d.id, error: null });
      await store.finishRun({ runId: "run-1", startedAt: at(1), finishedAt: at(2), status: "succeeded", sources: [] });
      const [run] = await store.listRuns(5);
      expect(run).toMatchObject({ runId: "run-1", status: "succeeded", finishedAt: at(2) });
    });

    if (name === "postgres") {
      it("enforces append-only provenance tables at the database level", async () => {
        const d = doc("immutable");
        await store.putDocument(d);
        await applyObs(store, obs(d.id, 1), at(1));
        const pool = (store as PostgresStore).pool;
        for (const sql of [
          "update source_documents set url = 'x'",
          "delete from source_documents",
          "update legal_events set title = 'x'",
          "update citations set excerpt = 'x'",
          "update event_claims set value = 'x'",
          "delete from claim_citations"
        ]) {
          await expect(pool.query(sql), sql).rejects.toThrow(/append-only/);
        }
      });

      it("compresses stored bodies", async () => {
        const body = JSON.stringify({ bills: Array.from({ length: 200 }, () => ({ title: "Securities Act amendment" })) });
        const d = doc(body);
        await store.putDocument(d);
        const { rows } = await (store as PostgresStore).pool.query("select octet_length(body) as n from source_documents where id = $1", [d.id]);
        expect(rows[0].n).toBeLessThan(body.length / 5);
      });

      it("re-running migrations is a no-op", async () => {
        await store.init();
        const { rows } = await (store as PostgresStore).pool.query("select count(*)::int as n from schema_migrations");
        expect(rows[0].n).toBe(1);
      });
    }
  });
}

if (!PG_URL) {
  describe.skip("Store contract: postgres (set TEST_DATABASE_URL to run)", () => {
    it("skipped", () => undefined);
  });
}
