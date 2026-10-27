import { Client } from "pg";
import { TEST_DATABASE_URL } from "./test-env";

/** Fresh schema for every test run, then apply migrations. */
export default async function setup() {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  const { migrate } = await import("../src/db/migrate");
  const { pool } = await import("../src/db/pool");
  await migrate();
  await pool.end();
}
