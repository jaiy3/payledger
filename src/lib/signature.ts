import { createHmac, timingSafeEqual } from "crypto";

export const SIGNATURE_HEADER = "PayLedger-Signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Stripe-style signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">.
 * Including the timestamp in the signed payload prevents replaying an old body.
 */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
  now = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing signature header" };

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isInteger(timestamp) || !provided) return { ok: false, reason: "malformed signature header" };
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}
