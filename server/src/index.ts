import { loadEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { runIngestion } from "./ingest/pipeline.js";
import { startScheduler } from "./services/scheduler.js";

const env = loadEnv();
const { store, server, ingest } = await createApp(env);

if (store.kind === "memory") {
  server.log.warn("DATABASE_URL not set: using the in-memory store; state is lost on restart");
}
if (env.API_TOKEN === undefined) {
  server.log.warn("API_TOKEN not set: mutating routes are unauthenticated (development only)");
}

const scheduler =
  env.INGEST_INTERVAL_MINUTES > 0
    ? startScheduler({
        intervalMs: env.INGEST_INTERVAL_MINUTES * 60_000,
        task: () => runIngestion({ ...ingest, store, log: server.log }),
        onError: (err) => server.log.error({ err }, "scheduled ingest failed")
      })
    : null;

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  server.log.info({ signal }, "shutting down");
  scheduler?.stop();
  await server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.listen({ host: env.HOST, port: env.PORT });
