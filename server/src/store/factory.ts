import type { Env } from "../config/env.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { Store } from "./store.js";

export function createStore(env: Pick<Env, "DATABASE_URL" | "DATABASE_POOL_MAX">): Store {
  return env.DATABASE_URL
    ? new PostgresStore({ connectionString: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX })
    : new MemoryStore();
}
