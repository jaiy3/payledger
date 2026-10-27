import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { logger } from "../logger";
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from "../lib/backoff";
import { newId } from "../lib/ids";
import { SIGNATURE_HEADER, signPayload } from "../lib/signature";

/**
 * Transactional outbox: the event and one delivery row per enabled endpoint are
 * written in the SAME transaction as the ledger entry. If the payment commits,
 * the webhook is guaranteed to be sent eventually; if it rolls back, no webhook
 * exists for a payment that never happened.
 */
export async function enqueueEvent(client: PoolClient, workspaceId: string, type: string, data: unknown) {
  const eventId = newId("evt");
  const payload = { id: eventId, type, created_at: new Date().toISOString(), data };
  await client.query("INSERT INTO events (id, workspace_id, type, payload) VALUES ($1, $2, $3, $4)", [
    eventId,
    workspaceId,
    type,
    payload,
  ]);
  await client.query(
    `INSERT INTO webhook_deliveries (id, event_id, endpoint_id, workspace_id)
     SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), $1, id, workspace_id
       FROM webhook_endpoints
      WHERE workspace_id = $2 AND enabled`,
    [eventId, workspaceId]
  );
  return eventId;
}

type ClaimedDelivery = {
  id: string;
  attempts: number;
  url: string;
  secret: string;
  payload: unknown;
  event_id: string;
};

/**
 * Claims due deliveries. FOR UPDATE SKIP LOCKED lets several dispatcher
 * processes run at once without sending the same delivery twice; a claim that
 * is never finished (process crash) expires after 30s and is picked up again.
 */
async function claimDue(limit: number): Promise<ClaimedDelivery[]> {
  const { rows } = await pool.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
        WHERE (status IN ('pending', 'retrying') AND next_attempt_at <= now())
           OR (status = 'sending' AND locked_until < now())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE webhook_deliveries d
          SET status = 'sending', attempts = d.attempts + 1,
              locked_until = now() + interval '30 seconds', updated_at = now()
         FROM due WHERE d.id = due.id
       RETURNING d.id, d.attempts, d.endpoint_id, d.event_id
     )
     SELECT c.id, c.attempts, c.event_id, e.url, e.secret, ev.payload
       FROM claimed c
       JOIN webhook_endpoints e ON e.id = c.endpoint_id
       JOIN events ev ON ev.id = c.event_id`,
    [limit]
  );
  return rows;
}

async function deliver(delivery: ClaimedDelivery) {
  const body = JSON.stringify(delivery.payload);
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PayLedger-Webhooks/1.0",
        "PayLedger-Event-Id": delivery.event_id,
        [SIGNATURE_HEADER]: signPayload(delivery.secret, body),
      },
      body,
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
    });
    statusCode = response.status;
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (!error) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'succeeded', last_status_code = $2, last_error = NULL, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [delivery.id, statusCode]
    );
    return;
  }

  const dead = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
  await pool.query(
    `UPDATE webhook_deliveries
        SET status = $2, last_status_code = $3, last_error = $4, locked_until = NULL,
            next_attempt_at = now() + ($5::int * interval '1 millisecond'), updated_at = now()
      WHERE id = $1`,
    [delivery.id, dead ? "dead" : "retrying", statusCode, error, retryDelayMs(delivery.attempts)]
  );
  if (dead) logger.warn({ deliveryId: delivery.id, error }, "Webhook delivery exhausted retries");
}

export async function dispatchOnce(limit = 25) {
  const claimed = await claimDue(limit);
  await Promise.all(claimed.map(deliver));
  return claimed.length;
}

export function startDispatcher(intervalMs = 1_000) {
  let running = false;
  let stopped = false;

  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchOnce();
    } catch (error) {
      logger.error({ err: error }, "Webhook dispatcher tick failed");
    } finally {
      running = false;
    }
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Manual replay of a failed delivery, as payment dashboards offer. */
export async function retryDelivery(workspaceId: string, deliveryId: string) {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('dead', 'retrying')
      RETURNING id`,
    [deliveryId, workspaceId]
  );
  return rows.length === 1;
}
