import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireApiKey, workspaceOf } from "../auth";
import { pool } from "../db/pool";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { withIdempotency } from "../services/idempotency";
import { deposit, transfer } from "../services/ledger";
import {
  getAccount,
  listAccountPostings,
  listAccounts,
  listDeliveries,
  listEndpoints,
  listEntries,
  serializeAccount,
} from "../services/queries";
import { reconcile } from "../services/reconciliation";
import { createSandbox } from "../services/sandbox";
import { retryDelivery } from "../services/webhooks";
import {
  createAccountSchema,
  depositSchema,
  endpointPatchSchema,
  limitSchema,
  transferSchema,
} from "./schemas";

export const v1 = Router();

const skipInTests = () => process.env.NODE_ENV === "test";

const sandboxLimit = rateLimit({
  skip: skipInTests,
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json(new ApiError(429, "rate_limited", "Too many sandboxes created. Try again later.").toBody()),
});

const apiLimit = rateLimit({
  skip: skipInTests,
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.header("authorization") ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  handler: (_req, res) =>
    res.status(429).json(new ApiError(429, "rate_limited", "Too many requests. Slow down.").toBody()),
});

v1.post("/sandbox", sandboxLimit, async (_req, res) => {
  res.status(201).json(await createSandbox());
});

v1.use(requireApiKey, apiLimit);

function idempotencyKeyOf(req: Request) {
  const key = req.header("idempotency-key")?.trim();
  if (!key) {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (e.g. a UUID) with every POST that moves money.");
  }
  if (key.length > 255) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 255 characters.");
  return key;
}

function sendIdempotent(res: Response, result: { status: number; body: unknown; replayed: boolean }) {
  if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(result.status).json(result.body);
}

// Accounts
v1.get("/accounts", async (req, res) => {
  res.json({ data: await listAccounts(workspaceOf(req)) });
});

v1.post("/accounts", async (req, res) => {
  const workspaceId = workspaceOf(req);
  const { name } = createAccountSchema.parse(req.body);
  const { rowCount } = await pool.query("SELECT 1 FROM accounts WHERE workspace_id = $1", [workspaceId]);
  if ((rowCount ?? 0) >= 20) throw new ApiError(422, "account_limit", "Sandbox workspaces are limited to 20 accounts.");
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, workspace_id, name) VALUES ($1, $2, $3)
     RETURNING id, name, type, currency, balance, created_at`,
    [newId("acc"), workspaceId, name]
  );
  res.status(201).json(serializeAccount(rows[0]));
});

v1.get("/accounts/:id", async (req, res) => {
  const account = await getAccount(workspaceOf(req), req.params.id);
  if (!account) throw new ApiError(404, "account_not_found", `Account not found: ${req.params.id}`);
  res.json(account);
});

v1.get("/accounts/:id/postings", async (req, res) => {
  const workspaceId = workspaceOf(req);
  const { limit } = limitSchema.parse(req.query);
  const account = await getAccount(workspaceId, req.params.id);
  if (!account) throw new ApiError(404, "account_not_found", `Account not found: ${req.params.id}`);
  res.json({ account, data: await listAccountPostings(workspaceId, req.params.id, limit) });
});

// Money movement (idempotent)
v1.post("/deposits", async (req, res) => {
  const workspaceId = workspaceOf(req);
  const key = idempotencyKeyOf(req);
  const input = depositSchema.parse(req.body);
  const result = await withIdempotency(workspaceId, key, { method: "POST", path: "/v1/deposits", body: input }, async (client) => ({
    status: 201,
    body: await deposit(client, workspaceId, {
      accountId: input.account_id,
      amount: BigInt(input.amount),
      description: input.description,
    }),
  }));
  sendIdempotent(res, result);
});

v1.post("/transfers", async (req, res) => {
  const workspaceId = workspaceOf(req);
  const key = idempotencyKeyOf(req);
  const input = transferSchema.parse(req.body);
  const result = await withIdempotency(workspaceId, key, { method: "POST", path: "/v1/transfers", body: input }, async (client) => ({
    status: 201,
    body: await transfer(client, workspaceId, {
      fromAccountId: input.from_account_id,
      toAccountId: input.to_account_id,
      amount: BigInt(input.amount),
      description: input.description,
    }),
  }));
  sendIdempotent(res, result);
});

// Ledger
v1.get("/entries", async (req, res) => {
  const { limit } = limitSchema.parse(req.query);
  res.json({ data: await listEntries(workspaceOf(req), limit) });
});

v1.get("/reconciliation", async (req, res) => {
  res.json(await reconcile(workspaceOf(req)));
});

// Webhooks
v1.get("/webhooks/endpoints", async (req, res) => {
  res.json({ data: await listEndpoints(workspaceOf(req)) });
});

v1.patch("/webhooks/endpoints/:id", async (req, res) => {
  const workspaceId = workspaceOf(req);
  const patch = endpointPatchSchema.parse(req.body);
  const { rowCount } = await pool.query(
    `UPDATE webhook_endpoints
        SET enabled = COALESCE($3, enabled),
            simulated_failure_rate = COALESCE($4, simulated_failure_rate)
      WHERE id = $1 AND workspace_id = $2`,
    [req.params.id, workspaceId, patch.enabled ?? null, patch.simulated_failure_rate ?? null]
  );
  if (rowCount === 0) throw new ApiError(404, "endpoint_not_found", `Webhook endpoint not found: ${req.params.id}`);
  const endpoint = (await listEndpoints(workspaceId)).find((e) => e.id === req.params.id);
  res.json(endpoint);
});

v1.get("/webhooks/deliveries", async (req, res) => {
  const { limit } = limitSchema.parse(req.query);
  res.json({ data: await listDeliveries(workspaceOf(req), limit) });
});

v1.post("/webhooks/deliveries/:id/retry", async (req, res) => {
  const ok = await retryDelivery(workspaceOf(req), req.params.id);
  if (!ok) throw new ApiError(422, "not_retryable", "Only deliveries that are retrying or dead can be retried.");
  res.status(202).json({ id: req.params.id, status: "pending" });
});
