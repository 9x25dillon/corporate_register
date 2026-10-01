import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import type { Briefing, Citation, ScriptSegment } from "../src/core/types.js";
import { CongressAdapter } from "../src/ingest/congress.js";
import { runIngestion } from "../src/ingest/pipeline.js";
import { RssAdapter } from "../src/ingest/rss.js";
import { SecAdapter } from "../src/ingest/sec.js";
import { BriefingService } from "../src/services/briefing.js";
import type { TtsClient } from "../src/services/elevenlabs.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/store.js";
import { sha256 } from "../src/util/hash.js";
import { congressWith, fakeFetch, fixture, steppingClock } from "./helpers.js";

const PG_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "test-token-0123456789abcdef";

/** TTS double: 1 byte of "audio" per character and a 10 ms/char alignment. */
class FakeTts implements TtsClient {
  readonly modelId = "eleven_v4";
  readonly voiceId = "voice-test";
  readonly outputFormat = "mp3_44100_128";
  readonly requests: string[] = [];
  async synthesize(text: string) {
    this.requests.push(text);
    const chars = [...text];
    return {
      audio: Buffer.alloc(chars.length, 0xff),
      alignment: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => i * 0.01),
        character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.01)
      }
    };
  }
}

const stores: [string, () => Promise<Store>][] = [["memory", async () => new MemoryStore()]];
if (PG_URL) {
  stores.push([
    "postgres",
    async () => {
      const c = new pg.Client({ connectionString: PG_URL });
      await c.connect();
      await c.query("drop schema if exists public cascade; create schema public;");
      await c.end();
      return new PostgresStore({ connectionString: PG_URL });
    }
  ]);
}

for (const [name, makeStore] of stores) {
  describe(`vertical slice end-to-end (${name})`, async () => {
    const store = await makeStore();
    await store.init();
    const audioDir = mkdtempSync(path.join(tmpdir(), "docket-audio-"));
    afterAll(async () => {
      await store.close();
      rmSync(audioDir, { recursive: true, force: true });
    });

    let congressBody = fixture("congress-bills.json");
    let secStatus = 200;
    const http = fakeFetch({
      "https://api.congress.test/": () => ({ body: congressBody }),
      "https://data.sec.test/": () => ({ body: fixture("sec-submissions.json"), status: secStatus }),
      "https://www.ftc.gov/feeds/": () => ({ body: fixture("ftc-competition.xml"), contentType: "application/rss+xml" }),
      "https://www.justice.gov/feeds/": () => ({ body: fixture("doj-atom.xml"), contentType: "application/atom+xml" })
    });
    const clock = steppingClock("2026-10-01T06:00:00.000Z");
    const adapters = [
      new CongressAdapter({ apiKey: "k", limit: 50, keywords: ["corporate", "shareholder"], baseUrl: "https://api.congress.test" }),
      new SecAdapter({ userAgent: "Docket test@example.com", ciks: ["320193"], forms: ["8-K", "10-Q"], baseUrl: "https://data.sec.test" }),
      new RssAdapter({ source: "ftc", publisher: "Federal Trade Commission", feeds: ["https://www.ftc.gov/feeds/press-release-competition.xml"], userAgent: "t", defaultDomain: "competition" }),
      new RssAdapter({ source: "doj", publisher: "Department of Justice, Antitrust Division", feeds: ["https://www.justice.gov/feeds/atr.xml"], userAgent: "t", defaultDomain: "enforcement" })
    ];
    const ingest = { adapters, http: { timeoutMs: 5000, userAgent: "t", fetchImpl: http.impl }, now: clock.now, sleep: async () => undefined };
    const tts = new FakeTts();
    const briefings = new BriefingService({ store, tts, audioDir, maxChars: 700, now: clock.now });
    const app = buildServer({ store, briefings, ingest, disabledSources: [], audioDir, apiToken: TOKEN, ttsConfigured: true });
    const auth = { authorization: `Bearer ${TOKEN}` };

    let run1CongressDoc = "";
    let briefing1: Briefing & { citations: Record<string, Citation> };

    it("rejects unauthenticated mutations", async () => {
      expect((await app.inject({ method: "POST", url: "/v1/ingest" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/ingest", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    });

    it("run 1 establishes baselines and records occurrences, with the key never in a URL", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/ingest", headers: auth });
      expect(res.statusCode).toBe(200);
      const report = res.json();
      expect(report.status).toBe("succeeded");
      const by = Object.fromEntries(report.sources.map((s: any) => [s.source, s]));
      expect(by.congress).toMatchObject({ created: 2, transitioned: 0, newDocuments: 1 });
      expect(by.sec).toMatchObject({ created: 2 });
      expect(by.ftc).toMatchObject({ created: 2 });
      expect(by.doj).toMatchObject({ created: 1 });
      for (const call of http.calls) expect(call.url).not.toMatch(/api_key/);

      const events = (await app.inject({ url: "/v1/events?kind=baseline&source=congress" })).json().events;
      expect(events).toHaveLength(2);
      const [bundle] = (await app.inject({ url: `/v1/events/${events[0].id}` })).json().citations;
      run1CongressDoc = bundle.documentId;
    });

    it("first briefing narrates only occurrences (baselines are not changes)", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/briefings/what-changed", headers: auth, payload: { limit: 10, synthesize: false } });
      expect(res.statusCode).toBe(201);
      briefing1 = res.json();
      expect(briefing1.windowStart).toBeNull();
      expect(briefing1.eventIds).toHaveLength(3);
      expect(briefing1.script).toContain("Three changes.");
      expect(briefing1.script).toContain("(shouting) FTC Sues to Block Merger");
      expect(briefing1.script).not.toContain("[shouting]");
      expect(briefing1.audio).toBeNull();
    });

    it("run 2 detects exactly one transition and stores only the changed document", async () => {
      congressBody = congressWith((bills) => {
        bills[0].latestAction = { actionDate: "2026-09-30", text: "Ordered to be Reported by the Yeas and Nays: 31 - 22." };
      });
      const report = (await app.inject({ method: "POST", url: "/v1/ingest", headers: auth })).json();
      const by = Object.fromEntries(report.sources.map((s: any) => [s.source, s]));
      expect(by.congress).toMatchObject({ created: 0, transitioned: 1, unchanged: 1, newDocuments: 1 });
      expect(by.sec).toMatchObject({ transitioned: 0, unchanged: 2, newDocuments: 0 });
      expect(by.ftc).toMatchObject({ unchanged: 2, newDocuments: 0 });

      const { object, history } = (await app.inject({ url: "/v1/objects/congress:bill:119:hr:4821" })).json();
      expect(object.revision).toBe(1);
      expect(object.proceduralStage).toBe("reported by committee");
      expect(history.map((e: any) => e.kind)).toEqual(["baseline", "transition"]);
    });

    let briefing2: Briefing & { citations: Record<string, Citation> };

    it("second briefing covers (previous windowEnd, now] and is synthesized with timed segments", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/briefings/what-changed", headers: auth, payload: { limit: 10, synthesize: true } });
      expect(res.statusCode).toBe(201);
      briefing2 = res.json();
      expect(briefing2.windowStart).toBe(briefing1.windowEnd);
      expect(briefing2.eventIds).toHaveLength(1);
      expect(briefing2.script).toContain("Previous state, as of September 14, 2026.\nReferred to committee.");
      expect(briefing2.script).toContain("Trigger, September 30, 2026.\nOrdered to be Reported by the Yeas and Nays: 31 - 22.");
      expect(briefing2.script).toContain("Difference.\nProcedural stage moved from in committee to reported by committee.");

      expect(briefing2.audio).toMatchObject({ modelId: "eleven_v4", timing: "aligned" });
      expect(briefing2.audio!.chunks).toBe(tts.requests.length);
      for (const r of tts.requests) expect(r.length).toBeLessThanOrEqual(700);
      for (const s of briefing2.segments) {
        expect(s.audioStart).not.toBeNull();
        expect(s.audioEnd!).toBeGreaterThanOrEqual(s.audioStart!);
      }
    });

    it("previous-state and new-state sentences cite different fetched documents; citations verify", async () => {
      const seg = (role: string) => briefing2.segments.find((s: ScriptSegment) => s.role === role)!;
      const prev = briefing2.citations[seg("previous-state").citationIds[0]!]!;
      const next = briefing2.citations[seg("new-state").citationIds[0]!]!;
      expect(prev.documentId).toBe(run1CongressDoc);
      expect(next.documentId).not.toBe(run1CongressDoc);

      const verify = (await app.inject({ url: `/v1/citations/${prev.id}/verify` })).json();
      expect(verify).toMatchObject({ documentIntact: true, locatorResolved: true });
      expect(verify.node.latestAction.text).toBe("Referred to the House Committee on Financial Services.");

      const raw = await app.inject({ url: `/v1/documents/${prev.documentId}/raw` });
      expect(raw.headers["x-content-type-options"]).toBe("nosniff");
      expect(raw.headers["content-type"]).toContain("text/plain");
      expect(sha256(raw.rawPayload)).toBe(prev.documentId);
    });

    it("verifies citations into XML feeds too", async () => {
      const occ = briefing1.citations[briefing1.segments.find((s) => s.role === "new-state" && s.eventId === briefing1.eventIds[0])!.citationIds[0]!]!;
      const verify = (await app.inject({ url: `/v1/citations/${occ.id}/verify` })).json();
      expect(verify).toMatchObject({ documentIntact: true, locatorResolved: true });
    });

    it("serves audio with byte ranges and refuses path traversal", async () => {
      const url = briefing2.audio!.urlPath;
      const full = await app.inject({ url });
      expect(full.statusCode).toBe(200);
      expect(full.rawPayload.byteLength).toBe(briefing2.audio!.byteLength);
      expect(sha256(full.rawPayload)).toBe(briefing2.audio!.sha256);

      const part = await app.inject({ url, headers: { range: "bytes=10-19" } });
      expect(part.statusCode).toBe(206);
      expect(part.headers["content-range"]).toBe(`bytes 10-19/${briefing2.audio!.byteLength}`);
      expect(part.rawPayload.byteLength).toBe(10);

      expect((await app.inject({ url, headers: { range: "bytes=999999-" } })).statusCode).toBe(416);
      expect((await app.inject({ url: "/v1/audio/..%2F..%2Fetc%2Fpasswd" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/v1/audio/abc.mp3" })).statusCode).toBe(404);
    });

    it("latest briefing and changes endpoints expose the ledger", async () => {
      const latest = (await app.inject({ url: "/v1/briefings/latest" })).json();
      expect(latest.id).toBe(briefing2.id);
      const changes = (await app.inject({ url: "/v1/changes?source=congress" })).json().changes;
      expect(changes.map((c: any) => c.event.kind)).toEqual(["transition"]);
      expect((await app.inject({ url: "/v1/events?kind=bogus" })).statusCode).toBe(400);
    });

    it("contains a failing source: run is partial, failure is logged, other sources proceed", async () => {
      secStatus = 503;
      const report = (await app.inject({ method: "POST", url: "/v1/ingest", headers: auth })).json();
      expect(report.status).toBe("partial");
      const sec = report.sources.find((s: any) => s.source === "sec");
      expect(sec.errors[0]).toMatch(/HTTP 503/);
      expect(report.sources.find((s: any) => s.source === "congress").errors).toEqual([]);
      const runs = (await app.inject({ url: "/v1/ingest/runs" })).json().runs;
      expect(runs[0].status).toBe("partial");
      secStatus = 200;
    });

    it("never runs two ingests at once", async () => {
      const [a, b] = await Promise.all([
        runIngestion({ ...ingest, store }),
        runIngestion({ ...ingest, store })
      ]);
      expect([a.status, b.status].sort()).toEqual(["completed", "skipped"]);
    });

    it("refuses synthesis when TTS is not configured", async () => {
      const noTts = new BriefingService({ store, tts: null, audioDir, maxChars: 700, now: clock.now });
      const app2 = buildServer({ store, briefings: noTts, ingest, disabledSources: [], audioDir, ttsConfigured: false });
      const res = await app2.inject({ method: "POST", url: "/v1/briefings/what-changed", payload: { synthesize: true } });
      expect(res.statusCode).toBe(409);
    });
  });
}
