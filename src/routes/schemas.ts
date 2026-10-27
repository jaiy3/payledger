import { z } from "zod";

// ₦10,000,000 per request, in kobo. Keeps every amount far inside 2^53.
const MAX_AMOUNT = 1_000_000_000;

export const amountSchema = z
  .number({ error: "amount must be an integer number of kobo" })
  .int("amount must be an integer number of kobo")
  .positive("amount must be greater than zero")
  .max(MAX_AMOUNT, "amount exceeds the per-request limit of ₦10,000,000");

const accountId = z.string().min(1).max(64);

export const transferSchema = z.object({
  from_account_id: accountId,
  to_account_id: accountId,
  amount: amountSchema,
  description: z.string().trim().max(140).optional(),
});

export const depositSchema = z.object({
  account_id: accountId,
  amount: amountSchema,
  description: z.string().trim().max(140).optional(),
});

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export const endpointPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    simulated_failure_rate: z.number().min(0).max(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
