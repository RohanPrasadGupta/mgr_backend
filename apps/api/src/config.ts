import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CORS_ORIGINS: z.string().default(""),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  FX_AUTO_REFRESH: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  RECURRING_AUTO_RUN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  FX_PROVIDER_URL: z.string().url().default("https://open.er-api.com/v6/latest/USD"),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
  }
  return parsed.data;
}
