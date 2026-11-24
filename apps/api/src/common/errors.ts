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
