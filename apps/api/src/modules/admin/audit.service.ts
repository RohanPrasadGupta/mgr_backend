import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import type { AdminAuditQuery } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { auditLog } from "../../db/schema";

export interface AuditActor { adminId: string | null; adminEmail: string | null; ip: string | null }
export interface AuditInput { action: string; targetUserId?: string | null; targetEmail?: string | null; reason?: string | null; meta?: Record<string, unknown> | null }

const view = (r: typeof auditLog.$inferSelect) => ({ ...r, meta: r.meta ?? null, createdAt: r.createdAt.toISOString() });

/** Append-only record of every admin sign-in, view and action. Nothing in the app updates or deletes these rows. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async write(actor: AuditActor, e: AuditInput) {
    await this.db.insert(auditLog).values({
      adminId: actor.adminId, adminEmail: actor.adminEmail, ip: actor.ip, action: e.action,
      targetUserId: e.targetUserId ?? null, targetEmail: e.targetEmail ?? null, reason: e.reason ?? null, meta: e.meta ?? null,
    });
  }

  async list(q: AdminAuditQuery) {
    const where: SQL[] = [];
    if (q.userId) where.push(eq(auditLog.targetUserId, q.userId));
    if (q.adminId) where.push(eq(auditLog.adminId, q.adminId));
    if (q.action) where.push(eq(auditLog.action, q.action));
    const cond = where.length ? and(...where) : undefined;
    const [{ n }] = (await this.db.select({ n: count() }).from(auditLog).where(cond)) as [{ n: number }];
    const rows = await this.db.select().from(auditLog).where(cond).orderBy(desc(auditLog.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map(view), total: Number(n), page: q.page, pageSize: q.pageSize };
  }

  async forUser(userId: string, limit = 10) {
    return (await this.db.select().from(auditLog).where(eq(auditLog.targetUserId, userId)).orderBy(desc(auditLog.createdAt)).limit(limit)).map(view);
  }
}
