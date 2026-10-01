# Docket — vertical slice 0.2

An audio-first corporate-law intelligence backend. It records law and corporate structure as **state that changes over time**. Every spoken sentence can be traced back to the source bytes that support it.

```text
Congress.gov ─┐                                   ┌──────────── provenance ledger (PostgreSQL) ───────────┐
SEC EDGAR ────┤   fetch    SourceDocument         │                                                        │
FTC RSS ──────┼──────────► sha256, gzip, ─────────┤  Observation ─► decide() ─► LegalEvent + Claim + Citation│
DOJ RSS ──────┘            append-only            │                    │              (append-only)         │
                                                  │                    ▼                                    │
                                                  │              LegalObject (current-state projection)     │
                                                  └────────────────────────────────────────────────────────┘
                                                                       │
                                     What Changed? compiler ◄──────────┘
                                     (script + sentence-level citation manifest)
                                                │
                                                ▼
                               ElevenLabs v4 /with-timestamps (chunked)
                                                │
                                                ▼
                         MP3 + per-segment audio offsets  ─►  mobile JSON API
```

Separation of concerns is strict. Adapters extract. `decide()` judges whether anything changed. The compiler writes the narration. ElevenLabs only performs it. No layer decides legal meaning for another.

---

## 1. Quick start

```bash
docker compose up -d postgres          # or point DATABASE_URL at any PostgreSQL ≥ 12
cd server
cp .env.example .env                   # add CONGRESS_API_KEY, SEC_USER_AGENT, ELEVENLABS_*
npm install
npm run dev                            # migrates on boot, serves http://localhost:8787
```

```bash
curl -X POST localhost:8787/v1/ingest -H "authorization: Bearer $API_TOKEN"
curl -X POST localhost:8787/v1/briefings/what-changed \
  -H "authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"limit":12,"synthesize":true}'
```

| Command | Purpose |
|---|---|
| `npm run dev` | API server with reload |
| `npm run ingest` | one-shot ingestion for cron/systemd (exit 0 ok · 1 failed · 2 lock busy) |
| `npm run migrate` | apply schema migrations without starting the server |
| `npm test` | unit + contract + end-to-end tests (set `TEST_DATABASE_URL` to include PostgreSQL) |
| `npm run typecheck` / `npm run build` | strict TypeScript, emit to `dist/` |

Without `DATABASE_URL` the server runs on an in-memory store and logs a warning. In production `DATABASE_URL` and a 24+ character `API_TOKEN` are mandatory, and the process refuses to start without them.

## 2. Core model

| Concept | Meaning | Mutability |
|---|---|---|
| `SourceDocument` | raw fetched bytes; `id = sha256(body)`; gzip-stored | append-only |
| `fetch_log` | every request, success or failure, linked to its run and document | append-only |
| `LegalEvent` | one recorded state of one legal object (`stateKey`, `revision`) | append-only |
| `Citation` | pointer into a document: `documentId` + `locator` (JSON pointer / XML path) + verbatim `excerpt` + canonical public `url` | append-only |
| `Claim` | one event field (`newState`, `previousState`, `action`, `difference`, `nextExpectedStage`) + ordered citation ids + `basis` (`source` / `derived` / `inferred`) + `rule` | append-only |
| `LegalObject` | current state per `stateKey`; a projection (fold) of its events | updated |
| `Briefing` | script, segment manifest, window, audio asset | write-once |

Append-only is enforced by PostgreSQL triggers, not only by convention. `UPDATE` or `DELETE` on a ledger table raises `restrict_violation`.

### Transition semantics (`src/core/decide.ts`, pure)

```text
no stored object         → baseline  (stateful source: first sighting is not a change)
                         → occurrence (press release: the item itself is the event)
fingerprint unchanged    → touch lastObservedAt only
observed state is older  → stale, rejected (prevents flapping on reordered/cached feeds)
fingerprint differs      → transition, revision + 1
```

On a transition, the `previousState` claim cites the citation that supported the prior state, which came from the earlier fetch. A What Changed? item therefore cites two documents fetched at different times: what the source said then, and what it says now.

Every identifier is deterministic: `event = H(stateKey, revision, fingerprint)` and `citation = H(event, document, locator)`. Concurrent writers are serialised per `stateKey` with `pg_advisory_xact_lock`. Whole ingestion runs are mutually exclusive across processes through a session advisory lock.

### Basis and rules

| basis | example | rule example |
|---|---|---|
| `source` | SEC: "Latest Form 8-K filed 2026-09-29, reporting …" | — |
| `derived` | Congress stage "Reported by committee." from the latest-action text | `congress.stage.reported` |
| `derived` | "Procedural stage moved from in committee to reported by committee." | `stage-diff` |
| `inferred` | "Next observable trigger: floor consideration" | `congress.stage.reported.next` |

A rule id is stored on every non-`source` claim, so heuristics can be audited and later replaced.

## 3. What Changed? broadcast

Window: `(previous What Changed? windowEnd, now]`. Consecutive briefings partition time, so no change is told twice and none is skipped. Override with `"since": "<ISO>"`, or `"since": null` to start from the beginning. Baselines are never narrated. Items are ranked by significance, then by source date.

```text
[low, steady voice, minimal affect, precise diction, calm rhythmic cadence]

What changed.

[brief pause]

One change since October 1, 2026.

[long pause]

Item 1. Congress. Corporate Disclosure Modernization Act of 2026.     ← cites newState
Previous state, as of September 14, 2026.\nReferred to committee.     ← cites the earlier document
Trigger, September 30, 2026.\nOrdered to be Reported by the Yeas and Nays: 31 - 22.
New state.\nReported by committee.
Difference.\nProcedural stage moved from in committee to reported by committee.
Next observable trigger.\nPlacement on the calendar or floor consideration.
…
End of changes.
```

**Manifest invariants** (tested):
1. `script.slice(segment.start, segment.end) === segment.text` for every segment.
2. Every segment about an event carries one or more citation ids. Editorial segments (opening, counts, closing) carry none.
3. Source text cannot steer the voice. ElevenLabs v4 reads `[...]` as delivery directions, so every bracket that comes from source text is rewritten to `(...)`. Only the compiler emits audio tags.
4. Compilation is deterministic.

**Synthesis.** The script is split at item boundaries, falling back to segment boundaries, so each request is at most `ELEVENLABS_MAX_CHARS`. Every chunk is re-prefixed with the delivery direction. Chunks are sent to `/v1/text-to-speech/{voice}/with-timestamps` and the MP3s are concatenated. Character alignment is mapped back onto segments, giving each segment `audioStart` and `audioEnd` in seconds. If a chunk's alignment does not reproduce its text exactly, timing for it and every later chunk is left `null` rather than guessed (`audio.timing = "partial"`).

## 4. API

Mutating routes require `Authorization: Bearer $API_TOKEN` whenever `API_TOKEN` is set.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | store kind, DB ping, enabled/disabled sources, TTS configured |
| `POST` 🔒 | `/v1/ingest` | run ingestion; `409` if a run is already in progress |
| `GET` | `/v1/ingest/runs?limit=` | per-run, per-source report (requests, new documents, created/transitioned/unchanged/stale, errors) |
| `GET` | `/v1/events?limit&kind&source&domain&since&until` | ledger events (comma lists allowed) |
| `GET` | `/v1/changes?…` | transitions and occurrences, with their claims and citations |
| `GET` | `/v1/events/:id` | one event bundle |
| `GET` | `/v1/objects/:stateKey` | current state and full revision history of one legal object |
| `GET` | `/v1/citations/:id` | citation and source document metadata |
| `GET` | `/v1/citations/:id/verify` | re-hash the stored bytes and resolve the locator → `{documentIntact, locatorResolved, node}` |
| `GET` | `/v1/documents/:id/raw` | exact source bytes (`text/plain`, `nosniff`, `CSP: sandbox`) |
| `POST` 🔒 | `/v1/briefings/what-changed` | `{limit?, synthesize?, since?}` → briefing with `citations` map |
| `GET` | `/v1/briefings/latest` / `/v1/briefings/:id` | stored briefings with resolved citations |
| `GET` | `/v1/audio/:filename` | MP3 with HTTP Range support (AVPlayer / ExoPlayer seeking) |

**Mobile contract.** Play `audio.urlPath`. While the audio plays, find the segment where `audioStart ≤ t < audioEnd`. Animate the `previous-state` → `new-state` transition for its `eventId`, and show `citations[segment.citationIds[i]]` under **View sources**. Agency keys and the ElevenLabs key stay on the server.

## 5. Sources

| Source | Request | `stateKey` | Fingerprint facts |
|---|---|---|---|
| Congress.gov | `GET /v3/bill?sort=updateDate desc`, key in `X-Api-Key` header; title keyword filter | `congress:bill:{congress}:{type}:{number}` | latest action date and text |
| SEC EDGAR | `data.sec.gov/submissions/CIK##########.json` per watched CIK, declared User-Agent, ≤ 8 req/s | `sec:{cik}:form:{form}` | form, accession |
| FTC | Competition press-release RSS | `ftc:release:{H(guid)}` | title, link |
| DOJ | RSS or Atom feeds set in `DOJ_FEEDS` | `doj:release:{H(guid)}` | title, link |

Credential-like query parameters are redacted before any URL is persisted. RSS documents that declare DTD entities are refused, which closes off entity-expansion attacks. A failing source or document is contained: the run is marked `partial`, and the failure is written to `fetch_log` and the run report.

## 6. Verification status

| Area | Status |
|---|---|
| Domain logic, compiler, chunking/timing, adapters on fixtures | Tested (unit) |
| Store contract incl. 12-way concurrent writes, append-only triggers, gzip, migration idempotence | Tested on in-memory and PostgreSQL 16 |
| Two-run ingestion → transition → briefing → audio → Range serving → citation verification | Tested end-to-end on both stores over HTTP (`fastify.inject`) |
| Live Congress / SEC / FTC / DOJ endpoints | **Not exercised from the build sandbox** (egress blocked). Fixtures follow the documented response shapes; confirm with a real ingest. |
| ElevenLabs `eleven_v4` + `/with-timestamps` | Implemented against the documented REST shape and tested with a TTS double. Confirm the model id and the per-request character limit on your account. |

## 7. Next increments

1. ~~Source-item provenance and immutable raw payload storage~~ ✔
2. Deep-fetch Congress bill actions, so `previousState` comes from the source's own history rather than only our last observation.
3. Broad SEC discovery (full-index / RSS) in addition to the CIK watchlist.
4. Parse FTC/DOJ docket and case identifiers into durable matter keys, so later press releases become *transitions* of one matter.
5. Typed `LegalState` per domain in place of state strings.
6. ~~Citation manifest for every sentence in a briefing~~ ✔ (plus audio-time alignment)
7. ~~PostgreSQL + migrations~~ ✔
8. ~~Scheduled ingestion worker with idempotency locks~~ ✔ (`INGEST_INTERVAL_MINUTES`, `npm run ingest`)
9. The other six broadcast modes as compilers over the same ledger (`src/broadcast/modes.ts` already holds their profiles).
10. Expo player with synchronised state cards and source links.
11. Retention policy for `source_documents`, object storage for audio, and per-client auth.

## Important scope note

This project summarizes procedural and corporate-law information as the sources report it. Generated narration must not be presented as legal advice, or as a substitute for the underlying filing, order, statute or case document. Every narrated sentence links to that document for this reason.
