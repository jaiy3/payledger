export const MAX_DELIVERY_ATTEMPTS = 6;

/**
 * Delay before the next webhook attempt: 2s, 4s, 8s, 16s, 32s... capped at 5 minutes.
 * Short on purpose so the public demo shows retries within a minute; a production
 * schedule would stretch over hours.
 */
export function retryDelayMs(attemptsSoFar: number): number {
  return Math.min(2 ** attemptsSoFar * 1000, 5 * 60_000);
}
