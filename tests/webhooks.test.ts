import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { signPayload } from "../src/lib/signature";
import { dispatchOnce } from "../src/services/webhooks";
import { api, newSandbox, transfer, type Sandbox } from "./helpers";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Other test files leave deliveries aimed at an address nobody listens on; park them.
  await pool.query("UPDATE webhook_deliveries SET status = 'dead'");
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function pointEndpointAtTestServer(sb: Sandbox, failureRate: number) {
  const { rows } = await pool.query<{ id: string }>(
    "UPDATE webhook_endpoints SET url = $2::text || '/demo/receiver/' || id, simulated_failure_rate = $3::real WHERE workspace_id = $1 RETURNING id",
    [sb.workspaceId, baseUrl, failureRate]
  );
  return rows[0].id;
}

async function deliveries(sb: Sandbox) {
  return (await api().get("/v1/webhooks/deliveries?limit=100").set(sb.auth).expect(200)).body.data as {
    id: string; event_type: string; status: string; attempts: number; last_status_code: number | null;
  }[];
}

async function drain() {
  while ((await dispatchOnce(100)) > 0);
}

describe("webhooks", () => {
  it("queues an event in the same transaction as the payment", async () => {
    const sb = await newSandbox();
    await pointEndpointAtTestServer(sb, 0);
    await drain(); // the two opening deposits

    await transfer(sb, { from_account_id: sb.ada.id, to_account_id: sb.tunde.id, amount: 5_000 }).expect(201);
    const pending = (await deliveries(sb)).filter((d) => d.event_type === "transfer.completed");
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });

  it("writes no event when the payment fails", async () => {
    const sb = await newSandbox();
    const before = (await deliveries(sb)).length;
    await transfer(sb, { from_account_id: sb.tunde.id, to_account_id: sb.ada.id, amount: 9_000_000 }).expect(422);
    expect((await deliveries(sb)).length).toBe(before);
  });

  it("delivers signed webhooks that the receiver accepts", async () => {
    const sb = await newSandbox();
    await pointEndpointAtTestServer(sb, 0);
    await drain();

    const all = await deliveries(sb);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((d) => d.status === "succeeded" && d.last_status_code === 200)).toBe(true);
  });

  it("schedules a retry with backoff when the receiver fails, then gives up", async () => {
    const sb = await newSandbox();
    await pointEndpointAtTestServer(sb, 1);
    await dispatchOnce(100);

    let rows = await deliveries(sb);
    expect(rows.every((d) => d.status === "retrying" && d.attempts === 1 && d.last_status_code === 503)).toBe(true);

    // Fast-forward: make every retry due now, repeatedly, until attempts run out.
    for (let i = 0; i < 6; i++) {
      await pool.query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE workspace_id = $1", [sb.workspaceId]);
      await dispatchOnce(100);
    }
    rows = await deliveries(sb);
    expect(rows.every((d) => d.status === "dead" && d.attempts === 6)).toBe(true);

    // Manual replay succeeds once the receiver recovers.
    await pool.query("UPDATE webhook_endpoints SET simulated_failure_rate = 0 WHERE workspace_id = $1", [sb.workspaceId]);
    await api().post(`/v1/webhooks/deliveries/${rows[0].id}/retry`).set(sb.auth).expect(202);
    await dispatchOnce(100);
    const replayed = (await deliveries(sb)).find((d) => d.id === rows[0].id)!;
    expect(replayed.status).toBe("succeeded");
  });

  it("receiver rejects unsigned or forged requests", async () => {
    const sb = await newSandbox();
    const endpointId = await pointEndpointAtTestServer(sb, 0);
    const body = JSON.stringify({ id: "evt_forged", type: "transfer.completed" });

    const unsigned = await fetch(`${baseUrl}/demo/receiver/${endpointId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);

    const forged = await fetch(`${baseUrl}/demo/receiver/${endpointId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PayLedger-Signature": signPayload("whsec_wrong", body) },
      body,
    });
    expect(forged.status).toBe(401);
  });
});
