import { Inject, Injectable, Logger } from "@nestjs/common";
import { verify } from "@node-rs/argon2";
import { eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../../db/db";
import {
  accounts, assetPrices, assets, attachments, budgets, categories, debtPayments, debts, goalContributions, goals, notes, recurringRules, refreshTokens, tags, trades,
  transactionTags, transactions, users,
} from "../../db/schema";
import { AppError, notFound } from "../../common/errors";
import { KEYS, KV, type Keys, type Kv } from "../../infra/kv";
import { STORAGE, type Storage } from "../../infra/storage";

const MAX_WRONG = 5;
const WINDOW_SEC = 15 * 60;

@Injectable()
export class AccountDeletionService {
  private readonly log = new Logger("AccountDeletion");
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  async deleteAccount(userId: string, password: string): Promise<void> {
    // Wrong-password attempts live in the shared store, so the limit holds across API instances and restarts.
    const failKey = this.keys.deleteFailures(userId);
    if (Number((await this.kv.get(failKey)) ?? 0) >= MAX_WRONG) throw new AppError(429, "too_many_attempts", "Too many incorrect passwords. Try again in a few minutes.");

    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    if (!(await verify(user.passwordHash, password).catch(() => false))) {
      await this.kv.incr(failKey, WINDOW_SEC);
      throw new AppError(403, "incorrect_password", "Incorrect password");
    }
    await this.kv.del(failKey, this.keys.loginFailures(user.email));
    await this.purge(userId);
  }

  /** Erases a user and everything they own (also used by the admin "delete user" action, which has its own checks). */
  async purge(userId: string): Promise<void> {
    const files = await this.db.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.userId, userId));
    // Hard delete, children before parents, in one transaction: either everything goes or nothing does.
    await this.db.transaction(async (tx) => {
      const assetIds = (await tx.select({ id: assets.id }).from(assets).where(eq(assets.userId, userId))).map((x) => x.id);
      const txIds = (await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.userId, userId))).map((x) => x.id);
      await tx.delete(attachments).where(eq(attachments.userId, userId));
      if (txIds.length) await tx.delete(transactionTags).where(inArray(transactionTags.transactionId, txIds));
      await tx.delete(tags).where(eq(tags.userId, userId));
      await tx.delete(goalContributions).where(eq(goalContributions.userId, userId));
      await tx.delete(goals).where(eq(goals.userId, userId));
      await tx.delete(debtPayments).where(eq(debtPayments.userId, userId));
      await tx.delete(debts).where(eq(debts.userId, userId));
      await tx.delete(notes).where(eq(notes.userId, userId));
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
    // Bytes go after the rows are gone (a failed file delete must not resurrect a half-deleted account).
    for (const f of files) await this.storage.delete(f.key).catch((e) => this.log.warn(`attachment cleanup failed: ${(e as Error).message}`));
    await this.storage.deleteUser(userId).catch((e) => this.log.warn(`attachment folder cleanup failed: ${(e as Error).message}`));
  }
}
