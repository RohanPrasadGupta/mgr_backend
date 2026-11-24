import { Inject, Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, isNull } from "drizzle-orm";
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, type LoginInput, type RegisterInput } from "@moneymgr/shared";
import { randomUUID } from "node:crypto";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { accounts, categories, currencies, refreshTokens, users } from "../../db/schema";
import { conflict, unauthorized, unprocessable } from "../../common/errors";
import { newRefreshToken, sha256, signAccessToken } from "./tokens";

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly config: Config) {}

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
    return { user: this.publicUser(user), ...(await this.issueTokens(user.id, randomUUID(), userAgent)) };
  }

  async login(input: LoginInput, userAgent?: string) {
    const [user] = await this.db.select().from(users).where(and(eq(users.email, input.email), isNull(users.deletedAt)));
    const ok = user ? await verify(user.passwordHash, input.password).catch(() => false) : false;
    if (!user || !ok) throw unauthorized("Invalid email or password");
    return { user: this.publicUser(user), ...(await this.issueTokens(user.id, randomUUID(), userAgent)) };
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

  private async issueTokens(userId: string, familyId: string, userAgent?: string) {
    const refreshToken = newRefreshToken();
    await this.db.insert(refreshTokens).values({
      userId, familyId, tokenHash: sha256(refreshToken), userAgent: userAgent?.slice(0, 200),
      expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });
    const accessToken = await signAccessToken(userId, this.config.JWT_SECRET, this.config.ACCESS_TOKEN_TTL_SEC);
    return { accessToken, refreshToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SEC };
  }

  publicUser(u: typeof users.$inferSelect) {
    return { id: u.id, email: u.email, name: u.name, baseCurrency: u.baseCurrency, timezone: u.timezone, locale: u.locale, weekStart: u.weekStart };
  }
}
