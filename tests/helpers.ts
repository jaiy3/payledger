import { randomUUID } from "crypto";
import request from "supertest";
import { app } from "../src/app";

export const api = () => request(app);

export async function newSandbox() {
  const created = await api().post("/v1/sandbox").expect(201);
  const key: string = created.body.api_key;
  const auth = { Authorization: `Bearer ${key}` };
  const accounts = (await api().get("/v1/accounts").set(auth).expect(200)).body.data as {
    id: string; name: string; type: string; balance: number;
  }[];
  const byName = (name: string) => accounts.find((a) => a.name === name)!;
  return {
    key,
    auth,
    workspaceId: created.body.workspace_id as string,
    ada: byName("Ada Okafor"),
    tunde: byName("Tunde Bello"),
    fees: accounts.find((a) => a.type === "fees")!,
    settlement: accounts.find((a) => a.type === "settlement")!,
  };
}

export type Sandbox = Awaited<ReturnType<typeof newSandbox>>;

export function transfer(sb: Sandbox, body: object, key: string = randomUUID()) {
  return api().post("/v1/transfers").set(sb.auth).set("Idempotency-Key", key).send(body);
}

export async function balanceOf(sb: Sandbox, accountId: string) {
  return (await api().get(`/v1/accounts/${accountId}`).set(sb.auth).expect(200)).body.balance as number;
}

export async function entryCount(sb: Sandbox) {
  return (await api().get("/v1/entries?limit=100").set(sb.auth).expect(200)).body.data.length as number;
}

export async function reconciliation(sb: Sandbox) {
  return (await api().get("/v1/reconciliation").set(sb.auth).expect(200)).body;
}
