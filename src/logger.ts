import pino from "pino";

export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : process.env.NODE_ENV === "production" ? "info" : "debug",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
