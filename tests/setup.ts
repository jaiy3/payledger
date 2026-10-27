import { afterAll } from "vitest";
import { TEST_DATABASE_URL } from "./test-env";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.WEBHOOK_DISPATCHER = "false";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4199";

afterAll(async () => {
  const { pool } = await import("../src/db/pool");
  await pool.end();
});
