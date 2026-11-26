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
  MAIL_TRANSPORT: z.enum(["smtp", "brevo", "log", "memory"]).default("log"),
  /** brevo = send through Brevo's HTTPS API (works where outgoing SMTP is blocked). MAIL_FROM must be a sender verified in Brevo. */
  BREVO_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  SMTP_URL: z.string().default("smtp://localhost:1025"),
  MAIL_FROM: z.string().default("MoneyMgr <no-reply@moneymgr.local>"),
  /** Per-IP requests per minute across the whole API (a page load makes ~10 calls, so keep this generous). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),
  /** Per-IP requests per minute on sign-in/sign-up/password endpoints. */
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).optional(),
  /** Failed sign-ins per email before a 15-minute lockout. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  /** Where transaction attachments are stored (local disk until S3 is configured). */
  // Which proxies may set X-Forwarded-For: "true" (any — local dev only), "false", or a comma-separated list of IPs/CIDRs.
  // In production list ONLY the reverse proxy / gateway network, or clients can forge their IP (rate limits, audit log).
  TRUST_PROXY: z.string().default("true").transform((v): boolean | string => (v === "true" ? true : v === "false" ? false : v)),
  UPLOAD_DIR: z.string().default("./uploads"),
  /** One log line per request (method, path, status, duration, IP, user, request id). Never bodies, headers or query strings. */
  LOG_REQUESTS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** text = easy to read in a terminal / Render; json = one JSON object per line, for log tools (CloudWatch, Loki…). */
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),
  /** Signs admin tokens and encrypts admin 2FA secrets. Must differ from JWT_SECRET so a customer token can never pass as an admin's. */
  ADMIN_SECRET: z.string().min(32, "ADMIN_SECRET must be at least 32 characters").optional(),
  /** Admin access tokens are short; the admin site refreshes them. Sessions end after this many hours regardless. */
  ADMIN_ACCESS_TTL_SEC: z.coerce.number().int().default(600),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** How long one support view of a user's data stays open. */
  ADMIN_SUPPORT_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
}).transform((c, ctx) => {
  if (!c.ADMIN_SECRET && c.NODE_ENV === "production") ctx.addIssue({ code: "custom", path: ["ADMIN_SECRET"], message: "ADMIN_SECRET is required in production" });
  if (c.MAIL_TRANSPORT === "brevo" && !c.BREVO_API_KEY) ctx.addIssue({ code: "custom", path: ["BREVO_API_KEY"], message: "BREVO_API_KEY is required when MAIL_TRANSPORT=brevo" });
  if (c.ADMIN_SECRET && c.ADMIN_SECRET === c.JWT_SECRET) ctx.addIssue({ code: "custom", path: ["ADMIN_SECRET"], message: "ADMIN_SECRET must differ from JWT_SECRET" });
  return {
    ...c,
    AUTH_RATE_LIMIT_PER_MIN: c.AUTH_RATE_LIMIT_PER_MIN ?? (c.NODE_ENV === "test" ? 1000 : 10),
    // development/test fallback: a key derived from JWT_SECRET (still a different key, so user tokens never verify as admin ones)
    ADMIN_SECRET: c.ADMIN_SECRET ?? `admin:${c.JWT_SECRET}`,
  };
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`);
  }
  return parsed.data;
}
