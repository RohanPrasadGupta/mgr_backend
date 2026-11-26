import { Inject, Injectable, SetMetadata, createParamDecorator, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { admins } from "../../db/schema";
import { AppError, unauthorized } from "../../common/errors";
import { verifyAdminToken } from "./crypto";
import type { AuditActor } from "./audit.service";

export type AdminActor = AuditActor & { adminId: string; adminEmail: string; role: "owner" | "admin" };
export type AdminRequest = FastifyRequest & { admin: AdminActor };

const OWNER_ONLY = "admin:owner-only";
const ALLOW_PENDING_PASSWORD = "admin:allow-pending-password";
/** Only owners may call this (managing other admins). */
export const OwnerOnly = () => SetMetadata(OWNER_ONLY, true);
/** Reachable while the admin still has to replace a one-time password (everything else is refused until then). */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);
/** The signed-in admin (id, email) plus the client IP — exactly what the audit log records. */
export const Admin = createParamDecorator((_d: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AdminRequest>().admin);

/** Admin routes are @Public() to the customer guard and protected here instead: admin tokens use their own key and audience. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config, @Inject(DB) private readonly db: Db, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let adminId: string;
    try { adminId = await verifyAdminToken(header.slice(7), "access", this.config.ADMIN_SECRET); } catch { throw unauthorized("Invalid or expired admin token"); }
    // checked on every request so disabling an admin takes effect immediately
    const [a] = await this.db.select({ id: admins.id, email: admins.email, role: admins.role, mustChangePassword: admins.mustChangePassword }).from(admins).where(and(eq(admins.id, adminId), isNull(admins.disabledAt)));
    if (!a) throw unauthorized("Admin account not active");
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]) === true;
    // checked on every request too: a one-time password and a lost owner role take effect at once, not when the token expires
    if (a.mustChangePassword && !flag(ALLOW_PENDING_PASSWORD)) throw new AppError(403, "password_change_required", "Choose a new password before continuing.");
    if (flag(OWNER_ONLY) && a.role !== "owner") throw new AppError(403, "owner_only", "Only owners can manage admin accounts.");
    req.admin = { adminId: a.id, adminEmail: a.email, role: a.role, ip: req.ip ?? null };
    return true;
  }
}
