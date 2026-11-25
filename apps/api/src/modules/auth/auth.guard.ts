import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { CONFIG } from "../../db/db";
import type { Config } from "../../config";
import { unauthorized } from "../../common/errors";
import { verifyAccessToken } from "./tokens";
import { KEYS, KV, type Keys, type Kv } from "../../infra/kv";
import { AppError } from "../../common/errors";

export const PUBLIC = "isPublic";
export const Public = () => SetMetadata(PUBLIC, true);

export type AuthedRequest = FastifyRequest & { userId: string };
export const UserId = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().userId);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let userId: string;
    try {
      userId = await verifyAccessToken(header.slice(7), this.config.JWT_SECRET);
    } catch {
      throw unauthorized("Invalid or expired token");
    }
    // A suspension also stops access tokens issued before it (their refresh tokens are already revoked).
    if (await this.kv.get(this.keys.userSuspended(userId))) throw new AppError(403, "account_suspended", "This account has been suspended.");
    req.userId = userId;
    return true;
  }
}
