import { Inject, Injectable, createParamDecorator, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { admins } from "../../db/schema";
import { unauthorized } from "../../common/errors";
import { verifyAdminToken } from "./crypto";
import type { AuditActor } from "./audit.service";

export type AdminRequest = FastifyRequest & { admin: AuditActor & { adminId: string; adminEmail: string } };
/** The signed-in admin (id, email) plus the client IP — exactly what the audit log records. */
export const Admin = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AdminRequest>().admin);

/** Admin routes are @Public() to the customer guard and protected here instead: admin tokens use their own key and audience. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config, @Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let adminId: string;
    try { adminId = await verifyAdminToken(header.slice(7), "access", this.config.ADMIN_SECRET); } catch { throw unauthorized("Invalid or expired admin token"); }
    // checked on every request so disabling an admin takes effect immediately
    const [a] = await this.db.select({ id: admins.id, email: admins.email }).from(admins).where(and(eq(admins.id, adminId), isNull(admins.disabledAt)));
    if (!a) throw unauthorized("Admin account not active");
    req.admin = { adminId: a.id, adminEmail: a.email, ip: req.ip ?? null };
    return true;
  }
}
