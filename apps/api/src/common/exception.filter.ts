import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AppError, isMissingUserViolation, isUniqueViolation } from "./errors";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Exceptions");
  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500;
    let code = "internal_error";
    let message = "Internal server error";
    let details: unknown;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = status === 404 ? "not_found" : status === 429 ? "rate_limited" : "http_error";
      message = err.message;
    } else if (isMissingUserViolation(err)) {
      status = 401;
      code = "unauthorized";
      message = "This account no longer exists";
    } else if (isUniqueViolation(err)) {
      status = 409;
      code = "conflict";
      message = "Resource already exists";
    } else if ((err as { statusCode?: number })?.statusCode === 429) {
      status = 429;
      code = "rate_limited";
      message = "Too many requests";
    } else {
      this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    void reply.status(status).send({ error: { code, message, ...(details ? { details } : {}) } });
  }
}
