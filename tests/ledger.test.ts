import { describe, expect, it } from "vitest";
import { api, balanceOf, entryCount, newSandbox, reconciliation, transfer } from "./helpers";

describe("sandbox", () => {
  it("starts funded and reconciled", async () => {
    const sb = await newSandbox();
    expect(sb.ada.balance).toBe(5_000_000);
    expect(sb.tunde.balance).toBe(1_250_000);
    expect(sb.settlement.balance).toBe(-6_250_000);

    const report = await reconciliation(sb);
    expect(report.balanced).toBe(true);
    expect(report.trial_balance).toBe(0);
  });

  it("rejects requests without a valid API key", async () => {
    await api().get("/v1/accounts").expect(401);
    await api().get("/v1/accounts").set("Authorization", "Bearer pl_test_nope").expect(401);
  });

  it("isolates workspaces from each other", async () => {
    const a = await newSandbox();
    const b = await newSandbox();
    const res = await transfer(a, { from_account_id: b.ada.id, to_account_id: a.tunde.id, amount: 100 });
    expect(res.status).toBe(404);
  });
});

describe("transfers", () => {
  it("posts a balanced three-leg entry with the fee", async () => {
    const sb = await newSandbox();
    const res = await transfer(sb, {
      from_account_id: sb.ada.id,
      to_account_id: sb.tunde.id,
      amount: 250_000,
      description: "Rent share",
    });

    expect(res.status).toBe(201);
    expect(res.body.fee).toBe(1_250);
    expect(res.body.postings).toEqual([
      { account_id: sb.ada.id, amount: -251_250, balance_after: 4_748_750 },
      { account_id: sb.tunde.id, amount: 250_000, balance_after: 1_500_000 },
      { account_id: sb.fees.id, amount: 1_250, balance_after: 1_250 },
    ]);
    expect(await balanceOf(sb, sb.ada.id)).toBe(4_748_750);
    expect((await reconciliation(sb)).balanced).toBe(true);
  });

  it("refuses to overdraw and changes nothing", async () => {
    const sb = await newSandbox();
    const before = await entryCount(sb);
    const res = await transfer(sb, { from_account_id: sb.tunde.id, to_account_id: sb.ada.id, amount: 1_250_000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("insufficient_funds");
    expect(await balanceOf(sb, sb.tunde.id)).toBe(1_250_000);
    expect(await entryCount(sb)).toBe(before);
  });

  it("validates input", async () => {
    const sb = await newSandbox();
    const cases = [
      { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 10.5 },
      { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: -5 },
      { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: "100" },
      { from_account_id: sb.ada.id, amount: 100 },
    ];
    for (const body of cases) expect((await transfer(sb, body)).status).toBe(400);
    expect((await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.ada.id, amount: 100 })).status).toBe(422);
    expect((await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.fees.id, amount: 100 })).status).toBe(422);
  });
});

describe("concurrency", () => {
  it("never overdraws under 30 simultaneous transfers", async () => {
    const sb = await newSandbox();
    // Tunde holds ₦12,500. Each transfer costs ₦1,000 + ₦5 fee, so exactly 12 can succeed.
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        transfer(sb, { from_account_id: sb.tunde.id, to_account_id: sb.ada.id, amount: 100_000 })
      )
    );
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(12);
    expect(statuses.filter((s) => s === 422)).toHaveLength(18);
    expect(await balanceOf(sb, sb.tunde.id)).toBe(1_250_000 - 12 * 100_500);

    const report = await reconciliation(sb);
    expect(report.balanced).toBe(true);
  });

  it("does not deadlock when transfers run in opposite directions", async () => {
    const sb = await newSandbox();
    const legs = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 1_000 })
        : transfer(sb, { from_account_id: sb.tunde.id, to_account_id: sb.ada.id, amount: 1_000 })
    );
    const results = await Promise.all(legs);

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await reconciliation(sb)).balanced).toBe(true);
  });
});
