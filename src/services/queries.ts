import { pool } from "../db/pool";
import { toSafeNumber } from "../lib/money";

export async function listAccounts(workspaceId: string) {
  const { rows } = await pool.query<{
    id: string; name: string; type: string; currency: string; balance: bigint; created_at: Date;
  }>(
    `SELECT id, name, type, currency, balance, created_at FROM accounts
      WHERE workspace_id = $1
      ORDER BY CASE type WHEN 'customer' THEN 0 WHEN 'fees' THEN 1 ELSE 2 END, created_at, name`,
    [workspaceId]
  );
  return rows.map(serializeAccount);
}

export async function getAccount(workspaceId: string, accountId: string) {
  const { rows } = await pool.query(
    "SELECT id, name, type, currency, balance, created_at FROM accounts WHERE workspace_id = $1 AND id = $2",
    [workspaceId, accountId]
  );
  return rows[0] ? serializeAccount(rows[0]) : null;
}

export function serializeAccount(row: {
  id: string; name: string; type: string; currency: string; balance: bigint; created_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency.trim(),
    balance: toSafeNumber(row.balance),
    created_at: row.created_at.toISOString(),
  };
}

/** Journal entries, newest first, each with its postings. */
export async function listEntries(workspaceId: string, limit: number) {
  const { rows } = await pool.query<{
    id: string; type: string; description: string | null; created_at: Date;
    postings: { account_id: string; amount: string; balance_after: string }[];
  }>(
    `SELECT e.id, e.type, e.description, e.created_at,
            json_agg(json_build_object(
              'account_id', p.account_id,
              'amount', p.amount::text,
              'balance_after', p.balance_after::text
            ) ORDER BY p.id) AS postings
       FROM journal_entries e
       JOIN postings p ON p.entry_id = e.id
      WHERE e.workspace_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $2`,
    [workspaceId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    description: r.description,
    created_at: r.created_at.toISOString(),
    postings: r.postings.map((p) => ({
      account_id: p.account_id,
      amount: toSafeNumber(BigInt(p.amount)),
      balance_after: toSafeNumber(BigInt(p.balance_after)),
    })),
  }));
}

/** An account statement: its postings with running balance, newest first. */
export async function listAccountPostings(workspaceId: string, accountId: string, limit: number) {
  const { rows } = await pool.query<{
    id: bigint; entry_id: string; type: string; description: string | null;
    amount: bigint; balance_after: bigint; created_at: Date;
  }>(
    `SELECT p.id, p.entry_id, e.type, e.description, p.amount, p.balance_after, p.created_at
       FROM postings p
       JOIN journal_entries e ON e.id = p.entry_id
       JOIN accounts a ON a.id = p.account_id
      WHERE a.workspace_id = $1 AND p.account_id = $2
      ORDER BY p.id DESC
      LIMIT $3`,
    [workspaceId, accountId, limit]
  );
  return rows.map((r) => ({
    id: r.id.toString(),
    entry_id: r.entry_id,
    type: r.type,
    description: r.description,
    amount: toSafeNumber(r.amount),
    balance_after: toSafeNumber(r.balance_after),
    created_at: r.created_at.toISOString(),
  }));
}

export async function listDeliveries(workspaceId: string, limit: number) {
  const { rows } = await pool.query(
    `SELECT d.id, d.event_id, ev.type AS event_type, d.endpoint_id, d.status, d.attempts,
            d.last_status_code, d.last_error, d.next_attempt_at, d.created_at, d.updated_at
       FROM webhook_deliveries d
       JOIN events ev ON ev.id = d.event_id
      WHERE d.workspace_id = $1
      ORDER BY d.created_at DESC, d.id
      LIMIT $2`,
    [workspaceId, limit]
  );
  return rows.map((r) => ({
    ...r,
    next_attempt_at: ["retrying", "pending"].includes(r.status) ? r.next_attempt_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));
}

export async function listEndpoints(workspaceId: string) {
  const { rows } = await pool.query(
    `SELECT id, url, secret, enabled, simulated_failure_rate, created_at
       FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId]
  );
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    secret_preview: `${String(r.secret).slice(0, 10)}…`,
    enabled: r.enabled,
    simulated_failure_rate: Number(r.simulated_failure_rate),
    created_at: r.created_at.toISOString(),
  }));
}
