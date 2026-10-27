import { migrate } from "./db/migrate";
import { pool } from "./db/pool";
import { logger } from "./logger";

migrate()
  .then(() => pool.end())
  .catch(async (error) => {
    logger.error({ err: error }, "Migration failed");
    await pool.end();
    process.exit(1);
  });
