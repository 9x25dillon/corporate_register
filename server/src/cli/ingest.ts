import { loadEnv } from "../config/env.js";
import { buildAdapters } from "../ingest/index.js";
import { runIngestion } from "../ingest/pipeline.js";
import { createStore } from "../store/factory.js";

/** One-shot ingestion for cron/systemd timers: `npm run ingest`. Exit 0 ok, 1 failed, 2 lock busy. */
const env = loadEnv();
const store = createStore(env);
await store.init();
try {
  const { adapters, disabled } = buildAdapters(env);
  for (const d of disabled) console.error(`skip ${d.source}: ${d.reason}`);
  const outcome = await runIngestion({ store, adapters, http: { timeoutMs: env.HTTP_TIMEOUT_MS, userAgent: env.HTTP_USER_AGENT } });
  if (outcome.status === "skipped") {
    console.error(outcome.reason);
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(outcome.report, null, 2));
    process.exitCode = outcome.report.status === "failed" ? 1 : 0;
  }
} finally {
  await store.close();
}
