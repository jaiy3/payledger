import { randomBytes } from "crypto";
import { config } from "../config";
import { pool, withTransaction } from "../db/pool";
import { newId } from "../lib/ids";
import { sha256 } from "../lib/hash";
import { logger } from "../logger";
import { deposit } from "./ledger";

export const SANDBOX_RETENTION_DAYS = 7;

/**
 * A fresh, isolated workspace per visitor: system accounts, two funded customer
 * accounts and a webhook endpoint pointed at the built-in receiver.
 * The API key is returned once; only its SHA-256 hash is stored.
 */
export async function createSandbox() {
  const apiKey = `pl_test_${randomBytes(24).toString("base64url")}`;
  const workspaceId = newId("ws");
  const endpointId = newId("we");
  const webhookSecret = `whsec_${randomBytes(24).toString("base64url")}`;

  const ids = {
    settlement: newId("acc"),
    fees: newId("acc"),
    ada: newId("acc"),
    tunde: newId("acc"),
  };

  await withTransaction(async (client) => {
    await client.query("INSERT INTO workspaces (id, name, api_key_hash, api_key_prefix) VALUES ($1, $2, $3, $4)", [
      workspaceId,
      "Sandbox",
      sha256(apiKey),
      apiKey.slice(0, 12),
    ]);
    await client.query(
      `INSERT INTO accounts (id, workspace_id, name, type, allow_negative) VALUES
         ($1, $5, 'Settlement', 'settlement', true),
         ($2, $5, 'Fee revenue', 'fees', false),
         ($3, $5, 'Ada Okafor', 'customer', false),
         ($4, $5, 'Tunde Bello', 'customer', false)`,
      [ids.settlement, ids.fees, ids.ada, ids.tunde, workspaceId]
    );
    await client.query(
      `INSERT INTO webhook_endpoints (id, workspace_id, url, secret, simulated_failure_rate)
       VALUES ($1, $2, $3, $4, 0.3)`,
      [endpointId, workspaceId, `${config.publicBaseUrl}/demo/receiver/${endpointId}`, webhookSecret]
    );
    await deposit(client, workspaceId, { accountId: ids.ada, amount: 5_000_000n, description: "Opening deposit" });
    await deposit(client, workspaceId, { accountId: ids.tunde, amount: 1_250_000n, description: "Opening deposit" });
  });

  return { workspace_id: workspaceId, api_key: apiKey, webhook_secret: webhookSecret };
}

/** Deletes sandboxes past retention. The append-only triggers allow DELETE only with this flag set. */
export async function purgeExpiredSandboxes() {
  return withTransaction(async (client) => {
    await client.query("SET LOCAL payledger.allow_purge = 'on'");
    const { rowCount } = await client.query(
      "DELETE FROM workspaces WHERE created_at < now() - make_interval(days => $1)",
      [SANDBOX_RETENTION_DAYS]
    );
    if (rowCount) logger.info({ purged: rowCount }, "Purged expired sandboxes");
    return rowCount ?? 0;
  });
}

export async function findWorkspaceByKey(apiKey: string) {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM workspaces WHERE api_key_hash = $1", [sha256(apiKey)]);
  return rows[0]?.id ?? null;
}
