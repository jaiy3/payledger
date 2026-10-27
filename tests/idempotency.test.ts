import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, entryCount, newSandbox, transfer } from "./helpers";

describe("idempotency keys", () => {
  it("replays the original response and moves money only once", async () => {
    const sb = await newSandbox();
    const key = randomUUID();
    const body = { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 50_000 };
    const before = await entryCount(sb);

    const first = await transfer(sb, body, key);
    const second = await transfer(sb, body, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(await entryCount(sb)).toBe(before + 1);
    expect(await balanceOf(sb, sb.ada.id)).toBe(5_000_000 - 50_250);
  });

  it("executes exactly once when the same key arrives concurrently", async () => {
    const sb = await newSandbox();
    const key = randomUUID();
    const body = { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 10_000 };
    const before = await entryCount(sb);

    const results = await Promise.all(Array.from({ length: 10 }, () => transfer(sb, body, key)));
    const statuses = results.map((r) => r.status);

    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses).toContain(201);
    expect(await entryCount(sb)).toBe(before + 1);
    expect(await balanceOf(sb, sb.ada.id)).toBe(5_000_000 - 10_050);
  });

  it("rejects reusing a key for a different request", async () => {
    const sb = await newSandbox();
    const key = randomUUID();
    await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 100 }, key).expect(201);
    const res = await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 200 }, key);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
  });

  it("treats logically identical bodies as the same request", async () => {
    const sb = await newSandbox();
    const key = randomUUID();
    await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 300 }, key).expect(201);
    const reordered = await transfer(sb, { amount: 300, to_account_id: sb.tunde.id, from_account_id: sb.ada.id }, key);
    expect(reordered.headers["idempotent-replayed"]).toBe("true");
  });

  it("stores business errors, so a retry gets the same answer", async () => {
    const sb = await newSandbox();
    const key = randomUUID();
    const body = { from_account_id: sb.tunde.id, to_account_id: sb.ada.id, amount: 2_000_000 };

    const first = await transfer(sb, body, key);
    expect(first.status).toBe(422);

    await api()
      .post("/v1/deposits")
      .set(sb.auth)
      .set("Idempotency-Key", randomUUID())
      .send({ account_id: sb.tunde.id, amount: 5_000_000 })
      .expect(201);

    const retry = await transfer(sb, body, key);
    expect(retry.status).toBe(422);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
  });

  it("requires the header on money-moving requests", async () => {
    const sb = await newSandbox();
    const res = await api()
      .post("/v1/transfers")
      .set(sb.auth)
      .send({ from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
  });
});
