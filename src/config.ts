import "dotenv/config";
import { z } from "zod";

const flag = z
  .enum(["true", "false", "1", "0"])
  .default("true")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  WEBHOOK_DISPATCHER: flag,
  DATABASE_SSL: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  publicBaseUrl: (parsed.PUBLIC_BASE_URL ?? parsed.RENDER_EXTERNAL_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, ""),
};
