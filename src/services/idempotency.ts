import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool";
import { ApiError } from "../lib/errors";
import { canonicalJson, sha256 } from "../lib/hash";

export const IN_PROGRESS_TIMEOUT_SECONDS = 60;

export type IdempotentResult = { status: number; body: unknown; replayed: boolean };

type KeyRow = {
  request_hash: string;
  status: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
  stale: boolean;
};

/**
 * Executes a mutating request at most once per (workspace, Idempotency-Key).
 *
 * - First request: the key is reserved (in_progress), the work runs, and the
 *   response is stored in the SAME transaction as the ledger writes, so a
 *   committed payment always has its stored response.
 * - Retry with the same key and body: the stored response is returned, nothing runs.
 * - Same key, different body: 422. Reusing a key for a different request is a client bug.
 * - Same key while the first is still running: 409.
 * - Business errors (e.g. insufficient funds) are stored too, like Stripe;
 *   unexpected errors release the key so the client can retry.
 */
export async function withIdempotency(
  workspaceId: string,
  key: string,
  request: { method: string; path: string; body: unknown },
  run: (client: PoolClient) => Promise<{ status: number; body: unknown }>
): Promise<IdempotentResult> {
  const requestHash = sha256(canonicalJson(request));

  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (workspace_id, key, request_hash, status)
     VALUES ($1, $2, $3, 'in_progress')
     ON CONFLICT (workspace_id, key) DO NOTHING
     RETURNING key`,
    [workspaceId, key, requestHash]
  );

  if (inserted.rowCount === 0) {
    const { rows } = await pool.query<KeyRow>(
      `SELECT request_hash, status, response_status, response_body,
              updated_at < now() - make_interval(secs => $3) AS stale
         FROM idempotency_keys WHERE workspace_id = $1 AND key = $2`,
      [workspaceId, key, IN_PROGRESS_TIMEOUT_SECONDS]
    );
    const existing = rows[0];
    if (!existing) {
      // Released by a failed attempt between our INSERT and SELECT; ask the client to retry.
      throw new ApiError(409, "idempotency_conflict", "Request with this Idempotency-Key was just released; retry.");
    }
    if (existing.request_hash !== requestHash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used with a different request. Use a new key for a new request."
      );
    }
    if (existing.status === "completed") {
      return { status: existing.response_status ?? 200, body: existing.response_body, replayed: true };
    }
    if (!existing.stale) {
      throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed.");
    }
    // The original attempt died mid-flight. Take it over, but only one taker wins.
    const takeover = await pool.query(
      `UPDATE idempotency_keys SET updated_at = now()
        WHERE workspace_id = $1 AND key = $2 AND status = 'in_progress'
          AND updated_at < now() - make_interval(secs => $3)`,
      [workspaceId, key, IN_PROGRESS_TIMEOUT_SECONDS]
    );
    if (takeover.rowCount === 0) {
      throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed.");
    }
  }

  try {
    const result = await withTransaction(async (client) => {
      const outcome = await run(client);
      await client.query(
        `UPDATE idempotency_keys
            SET status = 'completed', response_status = $3, response_body = $4, updated_at = now()
          WHERE workspace_id = $1 AND key = $2`,
        [workspaceId, key, outcome.status, JSON.stringify(outcome.body)]
      );
      return outcome;
    });
    return { ...result, replayed: false };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      await pool.query(
        `UPDATE idempotency_keys
            SET status = 'completed', response_status = $3, response_body = $4, updated_at = now()
          WHERE workspace_id = $1 AND key = $2`,
        [workspaceId, key, error.status, JSON.stringify(error.toBody())]
      );
    } else {
      await pool.query("DELETE FROM idempotency_keys WHERE workspace_id = $1 AND key = $2", [workspaceId, key]);
    }
    throw error;
  }
}
