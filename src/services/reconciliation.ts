import { pool } from "../db/pool";
import { toSafeNumber } from "../lib/money";

/**
 * Independent check of the ledger, the way finance teams verify a book:
 * - every account's stored balance equals the sum of its postings
 * - the whole workspace's postings sum to zero (trial balance)
 * Balances are maintained incrementally for speed; this proves they never drifted.
 */
export async function reconcile(workspaceId: string) {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    type: string;
    stored: bigint;
    computed: bigint;
    postings: bigint;
  }>(
    `SELECT a.id, a.name, a.type, a.balance AS stored,
            COALESCE(SUM(p.amount), 0)::bigint AS computed,
            COUNT(p.id)::bigint AS postings
       FROM accounts a
       LEFT JOIN postings p ON p.account_id = a.id
      WHERE a.workspace_id = $1
      GROUP BY a.id
      ORDER BY CASE a.type WHEN 'customer' THEN 0 WHEN 'fees' THEN 1 ELSE 2 END, a.created_at, a.name`,
    [workspaceId]
  );

  const accounts = rows.map((r) => ({
    account_id: r.id,
    name: r.name,
    type: r.type,
    stored_balance: toSafeNumber(r.stored),
    ledger_balance: toSafeNumber(r.computed),
    postings: toSafeNumber(r.postings),
    matches: r.stored === r.computed,
  }));
  const trialBalance = rows.reduce((sum, r) => sum + r.computed, 0n);

  return {
    balanced: trialBalance === 0n && accounts.every((a) => a.matches),
    trial_balance: toSafeNumber(trialBalance),
    accounts,
    checked_at: new Date().toISOString(),
  };
}
