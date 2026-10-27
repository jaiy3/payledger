import fs from "fs";
import path from "path";
import { pool } from "./pool";
import { logger } from "../logger";

/**
 * Minimal forward-only migration runner. Each file in /migrations runs once,
 * inside a transaction, and is recorded in schema_migrations.
 * An advisory lock stops two instances migrating at the same time.
 */
export async function migrate(migrationsDir = path.join(__dirname, "..", "..", "migrations")) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(728311)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info({ file }, "Applied migration");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(728311)").catch(() => undefined);
    client.release();
  }
}
