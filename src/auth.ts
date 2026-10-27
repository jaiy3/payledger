import type { NextFunction, Request, Response } from "express";
import { ApiError } from "./lib/errors";
import { findWorkspaceByKey } from "./services/sandbox";

declare global {
  namespace Express {
    interface Request {
      workspaceId?: string;
    }
  }
}

/** Bearer API key -> workspace. Keys are stored only as SHA-256 hashes. */
export async function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const key = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!key) throw new ApiError(401, "unauthorized", "Missing API key. Send Authorization: Bearer <key>.");

  const workspaceId = await findWorkspaceByKey(key);
  if (!workspaceId) throw new ApiError(401, "invalid_api_key", "Invalid API key.");

  req.workspaceId = workspaceId;
  next();
}

export function workspaceOf(req: Request) {
  if (!req.workspaceId) throw new ApiError(401, "unauthorized", "Not authenticated.");
  return req.workspaceId;
}
