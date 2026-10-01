import { buildServer } from "./api/server.js";
import type { Env } from "./config/env.js";
import { buildAdapters } from "./ingest/index.js";
import { BriefingService } from "./services/briefing.js";
import { ElevenLabsClient, type TtsClient } from "./services/elevenlabs.js";
import { createStore } from "./store/factory.js";

/** Composition root: the only place that knows every concrete implementation. */
export async function createApp(env: Env) {
  const store = createStore(env);
  await store.init();

  const tts: TtsClient | null =
    env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID
      ? new ElevenLabsClient({
          apiKey: env.ELEVENLABS_API_KEY,
          voiceId: env.ELEVENLABS_VOICE_ID,
          modelId: env.ELEVENLABS_MODEL_ID,
          outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
          baseUrl: env.ELEVENLABS_BASE_URL,
          timestamps: env.ELEVENLABS_TIMESTAMPS,
          voiceSettings: {
            stability: env.ELEVENLABS_STABILITY,
            similarity_boost: env.ELEVENLABS_SIMILARITY_BOOST,
            style: env.ELEVENLABS_STYLE,
            speed: env.ELEVENLABS_SPEED
          }
        })
      : null;

  const { adapters, disabled } = buildAdapters(env);
  const ingest = { adapters, http: { timeoutMs: env.HTTP_TIMEOUT_MS, userAgent: env.HTTP_USER_AGENT } };
  const briefings = new BriefingService({ store, tts, audioDir: env.AUDIO_DIR, maxChars: env.ELEVENLABS_MAX_CHARS });

  const server = buildServer({
    store,
    briefings,
    ingest,
    disabledSources: disabled,
    audioDir: env.AUDIO_DIR,
    apiToken: env.API_TOKEN,
    ttsConfigured: tts !== null,
    logLevel: env.LOG_LEVEL
  });
  return { store, server, ingest, briefings };
}
