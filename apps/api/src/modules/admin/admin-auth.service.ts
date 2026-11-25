import { Inject, Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";
import type { AdminLoginInput, AdminMfaInput } from "@moneymgr/shared";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { adminSessions, admins } from "../../db/schema";
import { AppError, unauthorized } from "../../common/errors";
import { KEYS, KV, type Keys, type Kv } from "../../infra/kv";
import { newRefreshToken, sha256 } from "../auth/tokens";
import { AuditService } from "./audit.service";
import { decrypt, encrypt, newTotpSecret, otpauthUrl, signAdminToken, verifyAdminToken, verifyTotp } from "./crypto";

const MAX_FAILS = 5;
const LOCK_SEC = 15 * 60;
const MFA_TOKEN_SEC = 5 * 60;
// A dummy hash so a login for an unknown email costs the same as one for a real admin (no timing oracle).
let dummyHash: Promise<string> | null = null;

export const adminProfile = (a: typeof admins.$inferSelect) => ({ id: a.id, email: a.email, name: a.name, lastLoginAt: a.lastLoginAt?.toISOString() ?? null });

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Step 1. Correct password → a short-lived 2FA token; first sign-in also returns a fresh authenticator secret to enrol. */
  async login(input: AdminLoginInput, ip: string | null) {
    const failKey = this.keys.adminLoginFailures(input.email);
    if (Number((await this.kv.get(failKey)) ?? 0) >= MAX_FAILS) throw new AppError(429, "too_many_attempts", "Too many failed sign-ins. Try again in 15 minutes.");
    const [a] = await this.db.select().from(admins).where(eq(admins.email, input.email));
    const ok = a ? await verify(a.passwordHash, input.password).catch(() => false) : await verify(await (dummyHash ??= hash("not-a-real-password")), input.password).catch(() => false);
    if (!a || !ok || a.disabledAt) {
      await this.kv.incr(failKey, LOCK_SEC);
      await this.audit.write({ adminId: a?.id ?? null, adminEmail: input.email, ip }, { action: "admin.login_failed" });
      throw unauthorized("Invalid email or password");
    }
    const mfaToken = await signAdminToken(a.id, "mfa", this.config.ADMIN_SECRET, MFA_TOKEN_SEC);
    if (a.totpEnabledAt) return { step: "mfa" as const, mfaToken };
    // Not enrolled yet: (re)issue a secret; it only becomes active once a code from it is verified.
    const secret = newTotpSecret();
    await this.db.update(admins).set({ totpSecretEnc: encrypt(secret, this.config.ADMIN_SECRET) }).where(eq(admins.id, a.id));
    return { step: "setup" as const, mfaToken, secret, otpauthUrl: otpauthUrl(secret, a.email) };
  }

  /** Step 2. A valid authenticator code → session. Codes can't be replayed; failures count toward the same lockout. */
  async mfa(input: AdminMfaInput, ip: string | null, userAgent?: string) {
    let adminId: string;
    try { adminId = await verifyAdminToken(input.mfaToken, "mfa", this.config.ADMIN_SECRET); } catch { throw unauthorized("Sign-in expired. Enter your password again."); }
    const [a] = await this.db.select().from(admins).where(and(eq(admins.id, adminId), isNull(admins.disabledAt)));
    if (!a?.totpSecretEnc) throw unauthorized("Sign-in expired. Enter your password again.");
    const failKey = this.keys.adminLoginFailures(a.email);
    if (Number((await this.kv.get(failKey)) ?? 0) >= MAX_FAILS) throw new AppError(429, "too_many_attempts", "Too many failed sign-ins. Try again in 15 minutes.");
    const step = verifyTotp(decrypt(a.totpSecretEnc, this.config.ADMIN_SECRET), input.code);
    const replay = step !== null && (await this.kv.incr(this.keys.adminTotpUsed(a.id, `${step}`), 120)) > 1;
    if (step === null || replay) {
      await this.kv.incr(failKey, LOCK_SEC);
      await this.audit.write({ adminId: a.id, adminEmail: a.email, ip }, { action: "admin.mfa_failed" });
      throw unauthorized("That code didn't work. Wait for the next one and try again.");
    }
    await this.kv.del(failKey);
    const enrolled = !a.totpEnabledAt;
    const [updated] = await this.db.update(admins).set({ lastLoginAt: new Date(), ...(enrolled ? { totpEnabledAt: new Date() } : {}) }).where(eq(admins.id, a.id)).returning();
    await this.audit.write({ adminId: a.id, adminEmail: a.email, ip }, { action: enrolled ? "admin.2fa_enrolled" : "admin.login" });
    return { ...(await this.issue(a.id, ip, userAgent)), admin: adminProfile(updated!) };
  }

  async refresh(token: string, ip: string | null, userAgent?: string) {
    const [row] = await this.db.select().from(adminSessions).where(eq(adminSessions.tokenHash, sha256(token)));
    if (!row || row.revokedAt || row.expiresAt < new Date()) throw unauthorized("Admin session ended. Sign in again.");
    const [a] = await this.db.select().from(admins).where(and(eq(admins.id, row.adminId), isNull(admins.disabledAt)));
    if (!a) throw unauthorized("Admin account not active");
    await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.id, row.id));
    // the session's hard end stays fixed: refreshing never extends it
    return this.issue(a.id, ip, userAgent, row.expiresAt);
  }

  async logout(token: string) {
    await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.tokenHash, sha256(token)), isNull(adminSessions.revokedAt)));
  }

  async me(adminId: string) {
    const [a] = await this.db.select().from(admins).where(eq(admins.id, adminId));
    if (!a) throw unauthorized();
    return adminProfile(a);
  }

  private async issue(adminId: string, ip: string | null, userAgent?: string, expiresAt?: Date) {
    const refreshToken = newRefreshToken();
    await this.db.insert(adminSessions).values({ adminId, tokenHash: sha256(refreshToken), ip, userAgent: userAgent?.slice(0, 200), expiresAt: expiresAt ?? new Date(Date.now() + this.config.ADMIN_SESSION_HOURS * 3_600_000) });
    const accessToken = await signAdminToken(adminId, "access", this.config.ADMIN_SECRET, this.config.ADMIN_ACCESS_TTL_SEC);
    return { accessToken, refreshToken, expiresIn: this.config.ADMIN_ACCESS_TTL_SEC };
  }
}
