# Docket — first vertical slice

A runnable TypeScript backend skeleton for an audio-first corporate-law intelligence app.

**Pipeline**

```text
Congress.gov ─┐
SEC EDGAR ────┼─> CandidateLegalEvent ─> state diff ─> LegalEvent ─> What Changed? script ─> ElevenLabs v4
FTC RSS ──────┤                                      │
DOJ RSS ──────┘                                      └─> JSON API for mobile
```

The system deliberately keeps **source ingestion**, **legal state normalization**, **change detection**, **narration**, and **speech synthesis** separate. ElevenLabs renders the final script; it does not decide the legal meaning of a source.

## 1. Requirements

- Node.js 22+
- A Congress.gov API key
- An ElevenLabs API key + voice ID for audio synthesis
- A descriptive SEC User-Agent with contact information

FTC and DOJ RSS ingestion needs no API key. SEC's `data.sec.gov` submissions endpoint is public; this first slice watches specific CIKs supplied in configuration.

## 2. Install

```bash
cp .env.example .env
npm install
npm run dev
```

Server defaults to `http://localhost:8787`.

## 3. Configure

Minimum useful `.env`:

```dotenv
CONGRESS_API_KEY=your_key
SEC_USER_AGENT=Docket/0.1 you@example.com
SEC_CIKS=0000320193,0000789019
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=your_voice_id
```

Keep `ELEVENLABS_API_KEY` server-side. Never ship it in the mobile bundle.

## 4. Run the vertical slice

Ingest primary sources:

```bash
curl -X POST http://localhost:8787/v1/ingest
```

Inspect normalized changes:

```bash
curl 'http://localhost:8787/v1/changes?limit=20'
```

Generate a script only:

```bash
curl -X POST http://localhost:8787/v1/briefings/what-changed \
  -H 'content-type: application/json' \
  -d '{"limit":12,"synthesize":false}'
```

Generate ElevenLabs v4 audio:

```bash
curl -X POST http://localhost:8787/v1/briefings/what-changed \
  -H 'content-type: application/json' \
  -d '{"limit":12,"synthesize":true}'
```

The response includes an `audio.urlPath`, for example `/v1/audio/abc123....mp3`.

## 5. API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | health check |
| `POST` | `/v1/ingest` | run Congress/SEC/FTC/DOJ ingestion and state diff |
| `GET` | `/v1/events?limit=100` | normalized events |
| `GET` | `/v1/changes?limit=100` | detected state changes |
| `POST` | `/v1/briefings/what-changed` | compile and optionally synthesize a briefing |
| `GET` | `/v1/briefings/latest` | most recent briefing |
| `GET` | `/v1/audio/:filename` | stream generated MP3 |

## 6. Core data contract

Every adapter emits a `CandidateLegalEvent` with two especially important fields:

- `stateKey`: identity of the monitored legal/corporate state, e.g. a bill or an issuer/form pair.
- `fingerprint`: hash of the facts that represent the current source-reported state.

The pipeline compares the candidate against the stored snapshot. If the fingerprint changed, it creates a `LegalEvent` and attaches `previousState`.

That is the foundation of **What Changed?**:

```text
previous state
      ↓
trigger / source action
      ↓
new state
      ↓
next observable stage
```

## 7. Source behavior in this first slice

### Congress.gov

Fetches the latest bill list, applies configurable corporate/business-law keyword filtering, and keys state by bill. A production build should next fetch bill details/actions for candidates and add committee, sponsor, amendment, text-version, and status normalization.

### SEC

Uses `data.sec.gov/submissions/CIK##########.json` for configured CIKs. State is keyed by issuer + form so a new filing of the same form becomes a visible state transition. This is intentionally watchlist-based for the first slice.

### FTC

Consumes the official Competition Press Releases RSS feed.

### DOJ

Consumes Antitrust Division press releases, civil-case filings, and criminal-case filings feeds.

## 8. Narration strategy

The `script-compiler.ts` file produces delivery-aware text for ElevenLabs v4:

```text
[low, steady voice, minimal affect, precise diction, calm rhythmic cadence]

What changed.

[brief pause]

Previous state.
...

Trigger.
...

New state.
...
```

The factual layer stays separate from the vocal layer. This makes it possible to add `Morning Docket`, `Legislative Drift`, `Enforcement Pulse`, `Case Law`, `M&A`, and `Securities` as additional script compilers without rewriting ingestion.

## 9. Persistence

For simplicity, this slice uses an atomic JSON store at `data/state.json`. It is enough to prove the state-diff concept and survives restarts.

Before multi-user deployment, replace `JsonStore` with PostgreSQL while keeping the same domain contracts.

Suggested tables:

- `source_items`
- `legal_events`
- `state_snapshots`
- `briefings`
- `briefing_items`
- `audio_assets`

## 10. Mobile contract

A React Native / Expo client only needs to:

1. `POST /v1/briefings/what-changed`
2. render the returned script/event IDs
3. prepend the API origin to `audio.urlPath`
4. play the MP3
5. use `/v1/changes` to render the visible `previous -> current` cards

The mobile client never receives agency API keys or the ElevenLabs secret.

## 11. Next engineering increments

1. Add source-item provenance and immutable raw payload storage.
2. Deep-fetch Congress bill actions/details after keyword selection.
3. Add broad SEC discovery in addition to the CIK watchlist.
4. Parse FTC/DOJ docket/case identifiers into durable state keys.
5. Replace heuristic strings with a typed `LegalState` object.
6. Add a citation manifest for every sentence in a briefing.
7. PostgreSQL + migrations.
8. Scheduled ingestion worker with idempotency locks.
9. Add the other six broadcast modes as compilers over the same event graph.
10. Expo player with synchronized state cards and source links.

## Important scope note

This project summarizes source-reported procedural and corporate-law information. It should not present generated narration as legal advice or as a substitute for the underlying official filing, order, statute, or case document.
# corporate_register
A meditation app for highly specific data fans
