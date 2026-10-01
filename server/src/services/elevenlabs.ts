import { z } from "zod";
import type { Alignment } from "../broadcast/chunk.js";

export interface TtsResult {
  audio: Buffer;
  alignment: Alignment | null;
}

/** Port for speech synthesis; the briefing service depends on this, not on a vendor. */
export interface TtsClient {
  readonly modelId: string;
  readonly voiceId: string;
  readonly outputFormat: string;
  synthesize(text: string): Promise<TtsResult>;
}

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  baseUrl: string;
  timestamps: boolean;
  voiceSettings: VoiceSettings;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class TtsError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = "TtsError";
  }
}

const alignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number())
});

const timestampResponseSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: alignmentSchema.nullish()
});

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * ElevenLabs text-to-speech over REST.
 *   POST /v1/text-to-speech/{voice_id}                  → audio bytes
 *   POST /v1/text-to-speech/{voice_id}/with-timestamps  → { audio_base64, alignment }
 * The API key is sent only as the xi-api-key header and never logged or echoed.
 */
export class ElevenLabsClient implements TtsClient {
  readonly modelId: string;
  readonly voiceId: string;
  readonly outputFormat: string;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.modelId = opts.modelId;
    this.voiceId = opts.voiceId;
    this.outputFormat = opts.outputFormat;
  }

  async synthesize(text: string): Promise<TtsResult> {
    const { opts } = this;
    const path = `/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}${opts.timestamps ? "/with-timestamps" : ""}`;
    const url = new URL(path, opts.baseUrl);
    url.searchParams.set("output_format", opts.outputFormat);

    const settings = Object.fromEntries(Object.entries(opts.voiceSettings).filter(([, v]) => v !== undefined));
    const body = JSON.stringify({
      text,
      model_id: opts.modelId,
      ...(Object.keys(settings).length > 0 ? { voice_settings: settings } : {})
    });

    const fetchImpl = opts.fetchImpl ?? fetch;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxRetries = opts.maxRetries ?? 2;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "xi-api-key": opts.apiKey,
            "content-type": "application/json",
            accept: opts.timestamps ? "application/json" : "audio/mpeg"
          },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000)
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TtsError(null, `ElevenLabs request failed: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
        if (RETRYABLE.has(res.status) && attempt < maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        throw new TtsError(res.status, `ElevenLabs HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }

      if (!opts.timestamps) {
        return { audio: Buffer.from(await res.arrayBuffer()), alignment: null };
      }
      const parsed = timestampResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new TtsError(res.status, "ElevenLabs with-timestamps response did not match the expected shape");
      return { audio: Buffer.from(parsed.data.audio_base64, "base64"), alignment: parsed.data.alignment ?? null };
    }
  }
}
