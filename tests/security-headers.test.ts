import { describe, expect, it, vi } from "vitest";

const { helmetSpy } = vi.hoisted(() => {
  const helmetSpy = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
  return { helmetSpy };
});

vi.mock("helmet", () => ({ default: helmetSpy }));

/**
 * Helmet v8 changed the default Strict-Transport-Security max-age from 180 days
 * to 1 year. The app pins the value explicitly so a future default change cannot
 * silently alter the HSTS policy.
 */
describe("security headers", () => {
  it("pins the Strict-Transport-Security max-age to one year", async () => {
    await import("../src/app");

    expect(helmetSpy).toHaveBeenCalledTimes(1);
    const options = helmetSpy.mock.calls[0]?.[0] as
      | { strictTransportSecurity?: { maxAge?: number; includeSubDomains?: boolean } }
      | undefined;

    expect(options?.strictTransportSecurity).toMatchObject({
      maxAge: 31_536_000,
      includeSubDomains: true,
    });
  });
});
