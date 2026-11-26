import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import type { AdminCreateInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { adminSessions, admins } from "../../db/schema";
import { AppError, isUniqueViolation, notFound, unprocessable } from "../../common/errors";
import { KEYS, KV, type Keys, type Kv } from "../../infra/kv";
import { AuditService } from "./audit.service";
import type { AdminActor } from "./admin.guard";

type Row = typeof admins.$inferSelect;
export const adminAccount = (a: Row) => ({
  id: a.id, email: a.email, name: a.name, role: a.role, twoFactorEnabled: a.totpEnabledAt !== null, mustChangePassword: a.mustChangePassword,
  lastLoginAt: a.lastLoginAt?.toISOString() ?? null, disabledAt: a.disabledAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
});

/** 16 characters from 96 random bits: shown to the owner once, stored only as a hash, and must be replaced at first sign-in. */
export const oneTimePassword = () => randomBytes(12).toString("base64url");

/**
 * Admin accounts, managed by owners from the admin site. Every change is audited with the owner's reason, and the
 * rules that would let an owner lock everyone out are enforced here, not in the UI: no acting on yourself, and at
 * least one active owner always remains.
 */
@Injectable()
export class AdminAccountsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.db.select().from(admins).orderBy(asc(admins.createdAt))).map(adminAccount);
  }

  async create(actor: AdminActor, input: AdminCreateInput) {
    const temporaryPassword = oneTimePassword();
    let row: Row;
    try {
      [row] = (await this.db.insert(admins).values({ email: input.email, name: input.name, role: input.role, passwordHash: await hash(temporaryPassword), mustChangePassword: true }).returning()) as [Row];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "conflict", "An admin with this email already exists");
      throw e;
    }
    await this.audit.write(actor, { action: "admin.created", reason: input.reason, meta: { email: row.email, role: row.role, via: "admin-site" } });
    return { admin: adminAccount(row), temporaryPassword };
  }

  async disable(actor: AdminActor, id: string, reason: string) {
    const target = await this.target(actor, id, "disable");
    if (target.role === "owner") await this.keepAnOwner(id);
    const [row] = await this.db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, id)).returning();
    await this.endSessions(id);
    await this.audit.write(actor, { action: "admin.disabled", reason, meta: { email: target.email } });
    return adminAccount(row!);
  }

  async enable(actor: AdminActor, id: string, reason: string) {
    const target = await this.target(actor, id, "enable");
    const [row] = await this.db.update(admins).set({ disabledAt: null }).where(eq(admins.id, id)).returning();
    await this.kv.del(this.keys.adminLoginFailures(target.email));
    await this.audit.write(actor, { action: "admin.enabled", reason, meta: { email: target.email } });
    return adminAccount(row!);
  }

  async resetTwoFactor(actor: AdminActor, id: string, reason: string) {
    const target = await this.target(actor, id, "reset the authenticator of");
    const [row] = await this.db.update(admins).set({ totpSecretEnc: null, totpEnabledAt: null }).where(eq(admins.id, id)).returning();
    await this.endSessions(id);
    await this.audit.write(actor, { action: "admin.2fa_reset", reason, meta: { email: target.email } });
    return adminAccount(row!);
  }

  async resetPassword(actor: AdminActor, id: string, reason: string) {
    const target = await this.target(actor, id, "reset the password of");
    const temporaryPassword = oneTimePassword();
    const [row] = await this.db.update(admins).set({ passwordHash: await hash(temporaryPassword), mustChangePassword: true }).where(eq(admins.id, id)).returning();
    await this.endSessions(id);
    await this.kv.del(this.keys.adminLoginFailures(target.email));
    await this.audit.write(actor, { action: "admin.password_reset", reason, meta: { email: target.email } });
    return { admin: adminAccount(row!), temporaryPassword };
  }

  async setRole(actor: AdminActor, id: string, role: "owner" | "admin", reason: string) {
    const target = await this.target(actor, id, "change the role of");
    if (target.role === role) return adminAccount(target);
    if (target.role === "owner") await this.keepAnOwner(id);
    const [row] = await this.db.update(admins).set({ role }).where(eq(admins.id, id)).returning();
    await this.audit.write(actor, { action: "admin.role_changed", reason, meta: { email: target.email, from: target.role, to: role } });
    return adminAccount(row!);
  }

  /** The signed-in admin's own password. Clears the one-time-password lock; other sessions of this admin end. */
  async changeOwnPassword(actor: AdminActor, currentPassword: string, newPassword: string) {
    const [a] = await this.db.select().from(admins).where(eq(admins.id, actor.adminId));
    if (!a) throw notFound("Admin");
    if (!(await verify(a.passwordHash, currentPassword).catch(() => false))) throw new AppError(403, "incorrect_password", "Current password is incorrect");
    if (currentPassword === newPassword) throw unprocessable("same_password", "Choose a password different from the current one");
    await this.db.update(admins).set({ passwordHash: await hash(newPassword), mustChangePassword: false }).where(eq(admins.id, a.id));
    await this.audit.write(actor, { action: "admin.password_changed", meta: a.mustChangePassword ? { replacedOneTimePassword: true } : null });
  }

  private async target(actor: AdminActor, id: string, verb: string) {
    if (id === actor.adminId) throw unprocessable("own_account", `You can't ${verb} your own account here`);
    const [a] = await this.db.select().from(admins).where(eq(admins.id, id));
    if (!a) throw notFound("Admin");
    return a;
  }

  private async keepAnOwner(excludingId: string) {
    const [{ n }] = (await this.db.select({ n: count() }).from(admins).where(and(eq(admins.role, "owner"), isNull(admins.disabledAt), ne(admins.id, excludingId)))) as [{ n: number }];
    if (Number(n) === 0) throw unprocessable("last_owner", "At least one active owner must remain");
  }

  private async endSessions(adminId: string) {
    await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)));
  }
}
