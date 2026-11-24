import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { CONFIG } from "../../db/db";
import type { Config } from "../../config";
import { unauthorized } from "../../common/errors";
import { verifyAccessToken } from "./tokens";

export const PUBLIC = "isPublic";
export const Public = () => SetMetadata(PUBLIC, true);

export type AuthedRequest = FastifyRequest & { userId: string };
export const UserId = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().userId);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(CONFIG) private readonly config: Config) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    try {
      req.userId = await verifyAccessToken(header.slice(7), this.config.JWT_SECRET);
      return true;
    } catch {
      throw unauthorized("Invalid or expired token");
    }
  }
}
