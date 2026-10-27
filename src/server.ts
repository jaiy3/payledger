import { app } from "./app";
import { config } from "./config";
import { pool } from "./db/pool";
import { logger } from "./logger";
import { purgeExpiredSandboxes } from "./services/sandbox";
import { startDispatcher } from "./services/webhooks";

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, publicBaseUrl: config.publicBaseUrl }, "PayLedger listening");
});

const stopDispatcher = config.WEBHOOK_DISPATCHER ? startDispatcher() : undefined;

const purgeTimer = setInterval(() => {
  purgeExpiredSandboxes().catch((error) => logger.error({ err: error }, "Sandbox purge failed"));
}, 60 * 60_000);

const shutdown = async () => {
  logger.info("Shutting down");
  stopDispatcher?.();
  clearInterval(purgeTimer);
  server.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
