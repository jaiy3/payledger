import "dotenv/config";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://payledger:payledger@localhost:5433/payledger_test";
