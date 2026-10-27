import fs from "fs";
import path from "path";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { pool } from "./db/pool";
import { errorHandler } from "./errors-middleware";
import { logger } from "./logger";
import { openapi } from "./openapi";
import { receiver } from "./routes/receiver";
import { v1 } from "./routes/v1";

export const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://validator.swagger.io"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

// The receiver needs the raw body for signature verification, so it is mounted before express.json().
app.use("/demo/receiver", receiver);
app.use(express.json({ limit: "32kb" }));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "degraded", database: "down" });
  }
});

app.use("/v1", v1);
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "PayLedger API docs" }));

// Dashboard (built by Vite into dist/web).
const webDir = path.join(__dirname, "..", "dist", "web");
const builtWebDir = fs.existsSync(path.join(__dirname, "web")) ? path.join(__dirname, "web") : webDir;
app.use(express.static(builtWebDir, { index: "index.html", maxAge: "1h" }));

app.use((req, res) => {
  res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
});
app.use(errorHandler);
