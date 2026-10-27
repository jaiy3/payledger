import { Pool, types, type PoolClient } from "pg";
import { config } from "../config";

// BIGINT (OID 20) comes back from pg as a string by default. Money is BIGINT,
// so parse it straight into a JS BigInt and never through a float.
types.setTypeParser(20, (value) => BigInt(value));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

export type Db = Pool | PoolClient;

/**
 * Runs fn inside BEGIN/COMMIT on a dedicated connection. Any throw rolls back.
 * Deferred constraint triggers (the balanced-entry check) fire at COMMIT, so a
 * violation surfaces from the COMMIT statement and still rolls everything back.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
