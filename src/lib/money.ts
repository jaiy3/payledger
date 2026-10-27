/** All amounts are integer kobo (1 NGN = 100 kobo) held as BigInt. */

export const FEE_BPS = 50n; // 0.5%
export const FEE_CAP = 10_000n; // ₦100.00

/** Transfer fee: 0.5%, rounded up to the next kobo, capped at ₦100. */
export function transferFee(amount: bigint): bigint {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  const fee = (amount * FEE_BPS + 9_999n) / 10_000n;
  return fee < FEE_CAP ? fee : FEE_CAP;
}

/**
 * BigInt -> number for JSON. Amounts are capped well below 2^53 by request
 * validation, so this is exact; it throws rather than silently losing precision.
 */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`amount ${value} exceeds safe integer range`);
  }
  return Number(value);
}
