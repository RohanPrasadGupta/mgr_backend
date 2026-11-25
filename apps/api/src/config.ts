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
  /** Shared store for rate limits, lockouts and one-time tokens. Unset = in-process memory (single instance / tests only). */
  REDIS_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  /** Prefix for every Redis key this app writes, so one Redis can host several apps/environments without collisions. */
  REDIS_PREFIX: z.string().regex(/^[a-z0-9:_-]+$/i).default("mm:"),
  /** Public web URL used in email links (reset password, verify email). */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** smtp = send via SMTP_URL (Mailpit locally); log = print the link to the server log; memory = keep in process (tests). */
  MAIL_TRANSPORT: z.enum(["smtp", "log", "memory"]).default("log"),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("MoneyMgr <no-reply@moneymgr.local>"),
  /** Per-IP requests per minute across the whole API (a page load makes ~10 calls, so keep this generous). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
  /** Per-IP requests per minute on sign-in/sign-up/password endpoints. */
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).optional(),
  /** Failed sign-ins per email before a 15-minute lockout. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  /** Where transaction attachments are stored (local disk until S3 is configured). */
  UPLOAD_DIR: z.string().default("./uploads"),
}).transform((c) => ({ ...c, AUTH_RATE_LIMIT_PER_MIN: c.AUTH_RATE_LIMIT_PER_MIN ?? (c.NODE_ENV === "test" ? 1000 : 10) }));
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
  }
  return parsed.data;
}
