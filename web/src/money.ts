const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });

/** Kobo -> "₦12,500.00" */
export const formatKobo = (kobo: number) => naira.format(kobo / 100);

/** "1,250.50" -> 125050 kobo, exactly (no float multiplication). Returns null if invalid. */
export function parseNaira(input: string): number | null {
  const clean = input.replace(/[₦,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".");
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return kobo > 0 && Number.isSafeInteger(kobo) ? kobo : null;
}

/** Same rule as the server: 0.5% rounded up, capped at ₦100. */
export const feeFor = (kobo: number) => Math.min(Math.ceil((kobo * 50) / 10_000), 10_000);

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
