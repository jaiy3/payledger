import { randomBytes } from "crypto";

/** Stripe-style prefixed IDs, e.g. acc_3kF9xQ2mT7bLp0Za. */
export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
