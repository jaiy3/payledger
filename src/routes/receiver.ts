import express, { Router } from "express";
import { pool } from "../db/pool";
import { SIGNATURE_HEADER, verifySignature } from "../lib/signature";

/**
 * A stand-in for a merchant's server, so the public demo has somewhere to send
 * webhooks. It verifies the signature exactly as a real receiver should (over
 * the raw body), then fails a configurable share of requests to exercise retries.
 */
export const receiver = Router();

receiver.post("/:endpointId", express.raw({ type: "application/json", limit: "64kb" }), async (req, res) => {
  const { rows } = await pool.query<{ secret: string; simulated_failure_rate: number }>(
    "SELECT secret, simulated_failure_rate FROM webhook_endpoints WHERE id = $1",
    [req.params.endpointId]
  );
  const endpoint = rows[0];
  if (!endpoint) {
    res.status(404).json({ received: false, reason: "unknown endpoint" });
    return;
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const verdict = verifySignature(endpoint.secret, body, req.header(SIGNATURE_HEADER));
  if (!verdict.ok) {
    res.status(401).json({ received: false, reason: verdict.reason });
    return;
  }

  if (Math.random() < Number(endpoint.simulated_failure_rate)) {
    res.status(503).json({ received: false, reason: "simulated outage" });
    return;
  }
  res.json({ received: true });
});
