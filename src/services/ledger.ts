import type { PoolClient } from "pg";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { toSafeNumber, transferFee } from "../lib/money";
import { enqueueEvent } from "./webhooks";

export type PostingInput = { accountId: string; amount: bigint };

type LockedAccount = {
  id: string;
  name: string;
  type: "customer" | "settlement" | "fees";
  balance: bigint;
  allow_negative: boolean;
};

export type PostedEntry = {
  id: string;
  type: "deposit" | "transfer";
  description: string | null;
  created_at: Date;
  postings: { account_id: string; amount: bigint; balance_after: bigint }[];
};

/**
 * Posts one balanced journal entry. Must run inside a transaction.
 *
 * 1. Lock every account touched, always in ascending ID order. Two transfers
 *    between the same accounts in opposite directions therefore queue on the
 *    same first lock instead of deadlocking.
 * 2. Check funds against the locked (current) balances.
 * 3. Insert the entry and its postings (with running balance), update balances.
 *
 * The database independently re-checks that the entry sums to zero (deferred
 * trigger) and that no customer balance went negative (CHECK constraint).
 */
export async function postEntry(
  client: PoolClient,
  input: { workspaceId: string; type: "deposit" | "transfer"; description?: string | null; postings: PostingInput[] }
): Promise<PostedEntry> {
  const { workspaceId, type, postings } = input;
  if (postings.length < 2) throw new Error("a journal entry needs at least two postings");
  const sum = postings.reduce((total, p) => total + p.amount, 0n);
  if (sum !== 0n) throw new Error(`postings must sum to zero, got ${sum}`);

  const accountIds = [...new Set(postings.map((p) => p.accountId))].sort();
  const { rows } = await client.query<LockedAccount>(
    `SELECT id, name, type, balance, allow_negative
       FROM accounts
      WHERE workspace_id = $1 AND id = ANY($2::text[])
      ORDER BY id
      FOR UPDATE`,
    [workspaceId, accountIds]
  );
  if (rows.length !== accountIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = accountIds.filter((id) => !found.has(id));
    throw new ApiError(404, "account_not_found", `Account not found: ${missing.join(", ")}`);
  }

  const accounts = new Map(rows.map((r) => [r.id, r]));
  const running = new Map(rows.map((r) => [r.id, r.balance]));
  const legs = postings.map((p) => {
    const next = running.get(p.accountId)! + p.amount;
    const account = accounts.get(p.accountId)!;
    if (next < 0n && !account.allow_negative) {
      throw new ApiError(422, "insufficient_funds", `${account.name} has insufficient funds`, {
        account_id: account.id,
        available: toSafeNumber(running.get(p.accountId)!),
        required: toSafeNumber(-p.amount),
      });
    }
    running.set(p.accountId, next);
    return { account_id: p.accountId, amount: p.amount, balance_after: next };
  });

  const entryId = newId("je");
  const description = input.description ?? null;
  const { rows: entryRows } = await client.query<{ created_at: Date }>(
    `INSERT INTO journal_entries (id, workspace_id, type, description) VALUES ($1, $2, $3, $4) RETURNING created_at`,
    [entryId, workspaceId, type, description]
  );

  await client.query(
    `INSERT INTO postings (entry_id, account_id, amount, balance_after)
     SELECT $1, account_id, amount, balance_after
       FROM unnest($2::text[], $3::bigint[], $4::bigint[]) AS t(account_id, amount, balance_after)`,
    [entryId, legs.map((l) => l.account_id), legs.map((l) => l.amount.toString()), legs.map((l) => l.balance_after.toString())]
  );

  const finalIds = [...running.keys()];
  await client.query(
    `UPDATE accounts a SET balance = t.balance
       FROM unnest($1::text[], $2::bigint[]) AS t(id, balance)
      WHERE a.id = t.id`,
    [finalIds, finalIds.map((id) => running.get(id)!.toString())]
  );

  return { id: entryId, type, description, created_at: entryRows[0].created_at, postings: legs };
}

async function systemAccountId(client: PoolClient, workspaceId: string, type: "settlement" | "fees") {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE workspace_id = $1 AND type = $2 ORDER BY created_at LIMIT 1",
    [workspaceId, type]
  );
  if (!rows[0]) throw new ApiError(500, "ledger_misconfigured", `Workspace has no ${type} account`);
  return rows[0].id;
}

async function assertCustomerAccount(client: PoolClient, workspaceId: string, accountId: string, field: string) {
  const { rows } = await client.query<{ type: string }>(
    "SELECT type FROM accounts WHERE workspace_id = $1 AND id = $2",
    [workspaceId, accountId]
  );
  if (!rows[0]) throw new ApiError(404, "account_not_found", `Account not found: ${accountId}`);
  if (rows[0].type !== "customer") {
    throw new ApiError(422, "invalid_account", `${field} must be a customer account`);
  }
}

const serializeEntry = (entry: PostedEntry, extra: Record<string, unknown>) => ({
  id: entry.id,
  type: entry.type,
  ...extra,
  description: entry.description,
  created_at: entry.created_at.toISOString(),
  postings: entry.postings.map((p) => ({
    account_id: p.account_id,
    amount: toSafeNumber(p.amount),
    balance_after: toSafeNumber(p.balance_after),
  })),
});

/** Money in from outside: settlement account (may go negative) -> customer. */
export async function deposit(
  client: PoolClient,
  workspaceId: string,
  input: { accountId: string; amount: bigint; description?: string }
) {
  await assertCustomerAccount(client, workspaceId, input.accountId, "account_id");
  const settlementId = await systemAccountId(client, workspaceId, "settlement");

  const entry = await postEntry(client, {
    workspaceId,
    type: "deposit",
    description: input.description ?? "Deposit",
    postings: [
      { accountId: settlementId, amount: -input.amount },
      { accountId: input.accountId, amount: input.amount },
    ],
  });

  const body = serializeEntry(entry, { amount: toSafeNumber(input.amount), account_id: input.accountId });
  await enqueueEvent(client, workspaceId, "deposit.completed", body);
  return body;
}

/**
 * Customer -> customer, with the fee as a third leg to the fees account:
 *   sender  -(amount + fee)
 *   receiver  +amount
 *   fees      +fee
 */
export async function transfer(
  client: PoolClient,
  workspaceId: string,
  input: { fromAccountId: string; toAccountId: string; amount: bigint; description?: string }
) {
  if (input.fromAccountId === input.toAccountId) {
    throw new ApiError(422, "same_account", "from_account_id and to_account_id must be different");
  }
  await assertCustomerAccount(client, workspaceId, input.fromAccountId, "from_account_id");
  await assertCustomerAccount(client, workspaceId, input.toAccountId, "to_account_id");

  const fee = transferFee(input.amount);
  const feesId = await systemAccountId(client, workspaceId, "fees");

  const entry = await postEntry(client, {
    workspaceId,
    type: "transfer",
    description: input.description ?? "Transfer",
    postings: [
      { accountId: input.fromAccountId, amount: -(input.amount + fee) },
      { accountId: input.toAccountId, amount: input.amount },
      { accountId: feesId, amount: fee },
    ],
  });

  const body = serializeEntry(entry, {
    amount: toSafeNumber(input.amount),
    fee: toSafeNumber(fee),
    from_account_id: input.fromAccountId,
    to_account_id: input.toAccountId,
  });
  await enqueueEvent(client, workspaceId, "transfer.completed", body);
  return body;
}
