import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTiming, planChunks } from "../broadcast/chunk.js";
import { compileWhatChanged, rankEvents } from "../broadcast/compiler.js";
import type { AudioAsset, Briefing } from "../core/types.js";
import type { Store } from "../store/store.js";
import { deriveId, sha256 } from "../util/hash.js";
import type { TtsClient } from "./elevenlabs.js";

/** How many window events are considered for ranking. Bounds memory and latency. */
const CANDIDATE_CEILING = 500;

export const AUDIO_FILENAME = /^[0-9a-f]{32}\.mp3$/;

export class ConflictError extends Error {
  readonly statusCode = 409;
}

export interface WhatChangedRequest {
  limit: number;
  synthesize: boolean;
  /**
   * undefined → since the previous What Changed? briefing (consecutive windows
   * partition time: (prev.windowEnd, now]); null → from the beginning.
   */
  since?: string | null;
}

export interface BriefingServiceOptions {
  store: Store;
  tts: TtsClient | null;
  audioDir: string;
  maxChars: number;
  now?: () => Date;
}

export class BriefingService {
  private readonly now: () => Date;

  constructor(private readonly opts: BriefingServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async whatChanged(req: WhatChangedRequest): Promise<Briefing> {
    const { store } = this.opts;
    if (req.synthesize && this.opts.tts === null) {
      throw new ConflictError("synthesis requested but ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not configured");
    }

    const windowEnd = this.now().toISOString();
    const windowStart =
      req.since !== undefined ? req.since : ((await store.latestBriefing("what-changed"))?.windowEnd ?? null);
    if (windowStart !== null && Date.parse(windowStart) >= Date.parse(windowEnd)) {
      throw new ConflictError("window start must precede now");
    }

    const candidates = await store.listEvents({
      kinds: ["transition", "occurrence"],
      since: windowStart,
      until: windowEnd,
      limit: CANDIDATE_CEILING
    });
    const selected = rankEvents(candidates).slice(0, req.limit);
    const bundles = await store.getBundles(selected.map((e) => e.id));
    const compiled = compileWhatChanged({ bundles, windowStart, totalInWindow: candidates.length });

    const id = deriveId("briefing", "what-changed", windowStart ?? "", windowEnd, compiled.eventIds.join(","));
    let segments = compiled.segments;
    let audio: AudioAsset | null = null;
    if (req.synthesize) ({ segments, audio } = await this.synthesize(id, compiled.segments));

    const briefing: Briefing = {
      id,
      mode: "what-changed",
      title: compiled.title,
      createdAt: windowEnd,
      windowStart,
      windowEnd,
      script: compiled.script,
      segments,
      eventIds: compiled.eventIds,
      citationIds: compiled.citationIds,
      audio
    };
    await store.putBriefing(briefing);
    return briefing;
  }

  private async synthesize(id: string, segments: Briefing["segments"]) {
    const tts = this.opts.tts!;
    const chunks = planChunks(segments, this.opts.maxChars);
    const results = [];
    // Sequential: preserves order and stays inside per-key concurrency limits.
    for (const chunk of chunks) results.push(await tts.synthesize(chunk.text));

    const bytes = Buffer.concat(results.map((r) => r.audio));
    const timed = applyTiming(segments, chunks, results.map((r) => r.alignment));
    const filename = `${id}.mp3`;
    await writeAtomic(path.join(this.opts.audioDir, filename), bytes);

    const audio: AudioAsset = {
      filename,
      urlPath: `/v1/audio/${filename}`,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      modelId: tts.modelId,
      voiceId: tts.voiceId,
      outputFormat: tts.outputFormat,
      chunks: chunks.length,
      timing: timed.timing,
      durationSeconds: timed.durationSeconds
    };
    return { segments: timed.segments, audio };
  }
}

async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}
