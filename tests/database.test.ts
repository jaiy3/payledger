import { describe, expect, it } from "vitest";
import { pool, withTransaction } from "../src/db/pool";
import { newSandbox, reconciliation, transfer } from "./helpers";

/**
 * The application checks these rules, but the database enforces them too.
 * These tests bypass the app and talk to Postgres directly.
 */
describe("database-level ledger guarantees", () => {
  it("rejects an unbalanced journal entry at commit", async () => {
    const sb = await newSandbox();
    const attempt = withTransaction(async (client) => {
      await client.query("INSERT INTO journal_entries (id, workspace_id, type) VALUES ('je_bad', $1, 'transfer')", [sb.workspaceId]);
      await client.query(
        "INSERT INTO postings (entry_id, account_id, amount, balance_after) VALUES ('je_bad', $1, -100, 0), ('je_bad', $2, 99, 0)",
        [sb.ada.id, sb.tunde.id]
      );
    });
    await expect(attempt).rejects.toThrow(/unbalanced/);
    const { rowCount } = await pool.query("SELECT 1 FROM journal_entries WHERE id = 'je_bad'");
    expect(rowCount).toBe(0);
  });

  it("rejects an entry with a single posting", async () => {
    const sb = await newSandbox();
    const attempt = withTransaction(async (client) => {
      await client.query("INSERT INTO journal_entries (id, workspace_id, type) VALUES ('je_one', $1, 'deposit')", [sb.workspaceId]);
    });
    await expect(attempt).rejects.toThrow(/at least 2/);
  });

  it("refuses to edit or delete postings", async () => {
    const sb = await newSandbox();
    await expect(pool.query("UPDATE postings SET amount = amount * 2 WHERE account_id = $1", [sb.ada.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM postings WHERE account_id = $1", [sb.ada.id])).rejects.toThrow(/append-only/);
  });

  it("refuses a negative customer balance even if the app forgot to check", async () => {
    const sb = await newSandbox();
    await expect(pool.query("UPDATE accounts SET balance = -1 WHERE id = $1", [sb.ada.id])).rejects.toThrow(/balance_non_negative/);
  });

  it("reconciliation catches a balance that drifted from its postings", async () => {
    const sb = await newSandbox();
    await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 1_000 }).expect(201);
    await pool.query("UPDATE accounts SET balance = balance + 1 WHERE id = $1", [sb.tunde.id]);

    const report = await reconciliation(sb);
    expect(report.balanced).toBe(false);
    const tunde = report.accounts.find((a: { account_id: string }) => a.account_id === sb.tunde.id);
    expect(tunde.matches).toBe(false);
    expect(tunde.stored_balance - tunde.ledger_balance).toBe(1);
  });
});
