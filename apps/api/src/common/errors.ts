export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const unauthorized = (msg = "Authentication required") => new AppError(401, "unauthorized", msg);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);

/** Postgres unique_violation, whether raw from `pg` or wrapped by Drizzle (`cause`). */
export function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x as { code?: string } | null)?.code;
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

/** Postgres foreign_key_violation on a user reference — e.g. a still-valid access token for an account that was deleted. */
export function isMissingUserViolation(e: unknown): boolean {
  const info = (x: unknown) => x as { code?: string; constraint?: string } | null;
  const c = info(e)?.code === "23503" ? info(e) : info((e as { cause?: unknown } | null)?.cause);
  return c?.code === "23503" && /user_id/.test(c.constraint ?? "");
}
