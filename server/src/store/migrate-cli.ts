import { loadEnv } from "../config/env.js";
import { PostgresStore } from "./postgres.js";
import { migrate } from "./migrate.js";

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const store = new PostgresStore({ connectionString: env.DATABASE_URL, migrate: false });
try {
  const applied = await migrate(store.pool);
  console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "schema up to date");
} finally {
  await store.close();
}
