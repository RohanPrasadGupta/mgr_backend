import { Inject, Injectable, Logger } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, type LoginInput, type RegisterInput } from "@moneymgr/shared";
import { randomUUID } from "node:crypto";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { accounts, categories, currencies, refreshTokens, users } from "../../db/schema";
import { AppError, conflict, notFound, unauthorized, unprocessable } from "../../common/errors";
import { KEYS, KV, type Keys, type Kv } from "../../infra/kv";
import { MAILER, actionEmail, type Mailer } from "../../infra/mailer";
import { newRefreshToken, sha256, signAccessToken } from "./tokens";

const LOCK_WINDOW_SEC = 15 * 60;
const RESET_TTL_SEC = 60 * 60; // 1 hour
const VERIFY_TTL_SEC = 48 * 60 * 60; // 2 days
const MAIL_COOLDOWN_SEC = 60; // one email per minute per address and kind

export const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id, email: u.email, name: u.name, baseCurrency: u.baseCurrency, timezone: u.timezone, locale: u.locale, weekStart: u.weekStart, emailVerified: !!u.emailVerifiedAt,
});

@Injectable()
export class AuthService {
  private readonly log = new Logger("Auth");
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async register(input: RegisterInput, userAgent?: string) {
    const baseCurrency = input.baseCurrency ?? "THB";
    const [cur] = await this.db.select().from(currencies).where(eq(currencies.code, baseCurrency));
    if (!cur) throw unprocessable("unsupported_currency", `Currency ${baseCurrency} is not supported`);
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (existing) throw conflict("email_taken", "An account with this email already exists");

    const passwordHash = await hash(input.password);
    const user = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: input.email, passwordHash, name: input.name, baseCurrency, timezone: input.timezone ?? "UTC" })
        .returning();
      await tx.insert(accounts).values({ userId: u!.id, name: "Cash", type: "cash", currency: baseCurrency });
      await tx.insert(categories).values([
        ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ userId: u!.id, name, kind: "expense" as const })),
        ...DEFAULT_INCOME_CATEGORIES.map((name) => ({ userId: u!.id, name, kind: "income" as const })),
      ]);
      return u!;
    });
    // Sign-up never fails because the mail server is down; the user can resend from the app.
    await this.sendVerification(user).catch((e) => this.log.warn(`verification email failed: ${(e as Error).message}`));
    return { user: publicUser(user), ...(await this.issueTokens(user.id, randomUUID(), userAgent)) };
  }

  async login(input: LoginInput, userAgent?: string) {
    const failKey = this.keys.loginFailures(input.email);
    const fails = Number((await this.kv.get(failKey)) ?? 0);
    if (fails >= this.config.LOGIN_MAX_FAILURES) {
      const wait = Math.max(1, Math.ceil((await this.kv.ttl(failKey)) / 60));
      throw new AppError(429, "too_many_attempts", `Too many failed sign-ins. Try again in ${wait} minute${wait === 1 ? "" : "s"} or reset your password.`);
    }
    const [user] = await this.db.select().from(users).where(and(eq(users.email, input.email), isNull(users.deletedAt)));
    const ok = user ? await verify(user.passwordHash, input.password).catch(() => false) : false;
    if (!user || !ok) {
      // Counted per email whether or not it exists, so the lockout itself reveals nothing.
      await this.kv.incr(failKey, LOCK_WINDOW_SEC);
      throw unauthorized("Invalid email or password");
    }
    await this.kv.del(failKey);
    return { user: publicUser(user), ...(await this.issueTokens(user.id, randomUUID(), userAgent)) };
  }

  async refresh(token: string, userAgent?: string) {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!row) throw unauthorized("Invalid refresh token");
    if (row.revokedAt) {
      // Reuse of a rotated token: assume theft, kill the whole family.
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      throw unauthorized("Refresh token reuse detected");
    }
    if (row.expiresAt < new Date()) throw unauthorized("Refresh token expired");
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return this.issueTokens(row.userId, row.familyId, userAgent);
  }

  async logout(token: string) {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (row) await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
  }

  // ── password reset ──

  /** Always resolves the same way so the endpoint can't be used to discover which emails are registered. */
  async forgotPassword(email: string) {
    const [user] = await this.db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
    if (!user) return;
    if (!(await this.coolDown("reset", user.id))) return;
    const token = newRefreshToken();
    await this.kv.set(this.keys.resetToken(sha256(token)), user.id, RESET_TTL_SEC);
    const url = `${this.config.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: user.email, subject: "Reset your MoneyMgr password",
      ...actionEmail({ name: user.name, intro: "Someone (hopefully you) asked to reset the password for your MoneyMgr account.", action: "Choose a new password", url, outro: "This link works once and expires in 1 hour. If you didn't ask for it, you can ignore this email — your password stays the same." }),
    }).catch((e) => this.log.warn(`reset email failed: ${(e as Error).message}`));
  }

  async resetPassword(token: string, password: string) {
    const userId = await this.kv.take(this.keys.resetToken(sha256(token)));
    if (!userId) throw new AppError(400, "invalid_token", "This reset link is invalid or has expired. Request a new one.");
    await this.setPassword(userId, password);
    // A reset proves control of the inbox: that also verifies the address, and clears any sign-in lockout.
    const [u] = await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt))).returning();
    const [cur] = u ? [u] : await this.db.select().from(users).where(eq(users.id, userId));
    if (cur) await this.kv.del(this.keys.loginFailures(cur.email));
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    if (!(await verify(user.passwordHash, currentPassword).catch(() => false))) throw new AppError(403, "incorrect_password", "Current password is incorrect");
    if (currentPassword === newPassword) throw unprocessable("same_password", "Choose a password you haven't used here");
    await this.setPassword(userId, newPassword);
  }

  /** New hash + every refresh token revoked: all other devices must sign in again. */
  private async setPassword(userId: string, password: string) {
    const passwordHash = await hash(password);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, userId));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    });
  }

  // ── email verification ──

  async resendVerification(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    if (user.emailVerifiedAt) return;
    if (!(await this.coolDown("verify", user.id))) throw new AppError(429, "too_soon", "A verification email was just sent. Check your inbox (and spam) or try again in a minute.");
    await this.sendVerification(user, false);
  }

  async verifyEmail(token: string) {
    const userId = await this.kv.take(this.keys.verifyToken(sha256(token)));
    if (!userId) throw new AppError(400, "invalid_token", "This verification link is invalid or has expired. Sign in and request a new one.");
    await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  }

  private async sendVerification(user: typeof users.$inferSelect, cooldown = true) {
    if (cooldown) await this.coolDown("verify", user.id);
    const token = newRefreshToken();
    await this.kv.set(this.keys.verifyToken(sha256(token)), user.id, VERIFY_TTL_SEC);
    const url = `${this.config.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: user.email, subject: "Confirm your email for MoneyMgr",
      ...actionEmail({ name: user.name, intro: "Welcome to MoneyMgr! Please confirm this is your email address so you can recover your account if you ever forget your password.", action: "Confirm my email", url, outro: "This link expires in 48 hours." }),
    });
  }

  /** True if this kind of email may be sent to this user now (and starts the cool-down). */
  private async coolDown(kind: string, id: string) {
    return (await this.kv.incr(this.keys.mailCooldown(kind, id), MAIL_COOLDOWN_SEC)) === 1;
  }

  private async issueTokens(userId: string, familyId: string, userAgent?: string) {
    const refreshToken = newRefreshToken();
    await this.db.insert(refreshTokens).values({
      userId, familyId, tokenHash: sha256(refreshToken), userAgent: userAgent?.slice(0, 200),
      expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });
    const accessToken = await signAccessToken(userId, this.config.JWT_SECRET, this.config.ACCESS_TOKEN_TTL_SEC);
    return { accessToken, refreshToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SEC };
  }
}
