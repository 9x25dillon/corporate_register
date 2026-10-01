import type pg from "pg";
import { MIGRATIONS, type Migration } from "./migrations.js";

/** Advisory-lock key pair reserved for schema migration (two-int4 key space). */
const MIGRATION_LOCK: [number, number] = [0x646b74, 0];

/**
 * Apply pending migrations, each in its own transaction, serialised across
 * processes by an advisory lock so concurrent boots cannot race.
 */
export async function migrate(pool: pg.Pool, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1, $2)", MIGRATION_LOCK);
    await client.query(
      "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())"
    );
    const done = new Set((await client.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [m.id]);
        await client.query("commit");
        applied.push(m.id);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${m.id} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", MIGRATION_LOCK).catch(() => undefined);
    client.release();
  }
}
