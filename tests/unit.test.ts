import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../src/lib/backoff";
import { canonicalJson } from "../src/lib/hash";
import { transferFee } from "../src/lib/money";
import { signPayload, verifySignature } from "../src/lib/signature";

describe("transferFee", () => {
  it("charges 0.5%, rounded up to the next kobo", () => {
    expect(transferFee(100_000n)).toBe(500n); // ₦1,000 -> ₦5
    expect(transferFee(101n)).toBe(1n); // 0.505 kobo rounds up
    expect(transferFee(1n)).toBe(1n);
  });

  it("caps at ₦100", () => {
    expect(transferFee(2_000_000n)).toBe(10_000n);
    expect(transferFee(999_999_999n)).toBe(10_000n);
  });

  it("rejects non-positive amounts", () => {
    expect(() => transferFee(0n)).toThrow();
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "transfer.completed" });
  const now = 1_761_600_000;

  it("verifies a payload it signed", () => {
    expect(verifySignature(secret, body, signPayload(secret, body, now), now)).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature(secret, body.replace("evt_1", "evt_2"), header, now).ok).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature("whsec_other", body, signPayload(secret, body, now), now).ok).toBe(false);
  });

  it("rejects a replayed old signature", () => {
    const header = signPayload(secret, body, now - 301);
    expect(verifySignature(secret, body, header, now)).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects missing or malformed headers", () => {
    expect(verifySignature(secret, body, undefined, now).ok).toBe(false);
    expect(verifySignature(secret, body, "garbage", now).ok).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially and caps at five minutes", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(retryDelayMs(20)).toBe(300_000);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("ignores undefined fields", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});
