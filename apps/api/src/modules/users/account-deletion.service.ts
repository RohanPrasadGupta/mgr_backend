import { Inject, Injectable } from "@nestjs/common";
import { verify } from "@node-rs/argon2";
import { eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../../db/db";
import { accounts, assetPrices, assets, budgets, categories, recurringRules, refreshTokens, trades, transactions, users } from "../../db/schema";
import { AppError, notFound } from "../../common/errors";

const MAX_WRONG = 5;
const WINDOW_MS = 15 * 60_000;

@Injectable()
export class AccountDeletionService {
  /** Wrong-password attempts per user (in-memory: enough for one instance; move to Redis when scaling out). */
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(@Inject(DB) private readonly db: Db) {}

  async deleteAccount(userId: string, password: string): Promise<void> {
    const now = Date.now();
    const a = this.attempts.get(userId);
    if (a && a.resetAt > now && a.count >= MAX_WRONG) throw new AppError(429, "too_many_attempts", "Too many incorrect passwords. Try again in a few minutes.");

    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    if (!(await verify(user.passwordHash, password).catch(() => false))) {
      const cur = a && a.resetAt > now ? a : { count: 0, resetAt: now + WINDOW_MS };
      this.attempts.set(userId, { count: cur.count + 1, resetAt: cur.resetAt });
      throw new AppError(403, "incorrect_password", "Incorrect password");
    }
    this.attempts.delete(userId);

    // Hard delete, children before parents, in one transaction: either everything goes or nothing does.
    await this.db.transaction(async (tx) => {
      const assetIds = (await tx.select({ id: assets.id }).from(assets).where(eq(assets.userId, userId))).map((x) => x.id);
      await tx.delete(trades).where(eq(trades.userId, userId));
      if (assetIds.length) await tx.delete(assetPrices).where(inArray(assetPrices.assetId, assetIds));
      await tx.delete(assets).where(eq(assets.userId, userId));
      await tx.delete(transactions).where(eq(transactions.userId, userId));
      await tx.delete(recurringRules).where(eq(recurringRules.userId, userId));
      await tx.delete(budgets).where(eq(budgets.userId, userId));
      await tx.delete(categories).where(eq(categories.userId, userId));
      await tx.delete(accounts).where(eq(accounts.userId, userId));
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });
  }
}
