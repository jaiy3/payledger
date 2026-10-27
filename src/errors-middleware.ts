import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "./lib/errors";
import { logger } from "./logger";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json(error.toBody());
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json(
      new ApiError(400, "validation_error", "Request validation failed", error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }))).toBody()
    );
    return;
  }
  if (error?.type === "entity.parse.failed") {
    res.status(400).json(new ApiError(400, "invalid_json", "Request body is not valid JSON").toBody());
    return;
  }

  const pgCode = (error as { code?: string })?.code;
  if (pgCode === "23514") {
    // A database constraint caught something the application check missed.
    logger.error({ err: error, path: req.path }, "Ledger constraint violation");
    res.status(422).json(new ApiError(422, "ledger_constraint_violation", "The ledger rejected this change.").toBody());
    return;
  }
  if (pgCode === "40P01" || pgCode === "40001") {
    res.status(503).json(new ApiError(503, "retry_later", "Concurrent update conflict; retry the request.").toBody());
    return;
  }

  logger.error({ err: error, method: req.method, path: req.path }, "Unhandled error");
  res.status(500).json(new ApiError(500, "internal_error", "An unexpected error occurred").toBody());
};
