import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  convertMinor, toLocalDate,
  type CreateTransactionInput, type CreateTransferInput, type ListTransactionsInput, type UpdateTransactionInput,
} from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { accounts, categories, transactions, users, type Account } from "../../db/schema";
import { AppError, notFound, unprocessable } from "../../common/errors";
import { FxService } from "../fx/fx.service";

type Tx = typeof transactions.$inferSelect;
const view = (t: Tx) => ({ ...t, fxRate: Number(t.fxRate) });

@Injectable()
export class TransactionsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(FxService) private readonly fx: FxService) {}

  private async getUser(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u;
  }

  private async getAccount(userId: string, id: string): Promise<Account> {
    const [a] = await this.db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId), isNull(accounts.deletedAt)));
    if (!a) throw unprocessable("invalid_account", "Account not found");
    if (a.archived) throw unprocessable("account_archived", "Account is archived");
    return a;
  }

  /** Explicit client rate wins; base currency is 1; otherwise the stored daily rate for the transaction date. */
  private async fxFor(accountCurrency: string, baseCurrency: string, onDate: string, rate?: number) {
    if (accountCurrency === baseCurrency) return 1;
    if (rate !== undefined) return rate;
    return (await this.fx.requireRate(accountCurrency, baseCurrency, onDate)).rate;
  }

  async create(userId: string, input: CreateTransactionInput, opts: { recurringId?: string } = {}) {
    if (input.clientId) {
      const [dup] = await this.db.select().from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.clientId, input.clientId)));
      if (dup) return view(dup);
    }
    const [user, account] = await Promise.all([this.getUser(userId), this.getAccount(userId, input.accountId)]);
    if (input.categoryId) await this.assertCategory(userId, input.categoryId, input.kind);
    const occurredAt = input.occurredAt ?? new Date();
    const fxRate = await this.fxFor(account.currency, user.baseCurrency, toLocalDate(occurredAt, user.timezone), input.fxRate);
    const [row] = await this.db
      .insert(transactions)
      .values({
        userId, accountId: account.id, categoryId: input.categoryId, kind: input.kind,
        amountMinor: input.amountMinor, currency: account.currency, fxRate: String(fxRate),
        baseAmountMinor: convertMinor(input.amountMinor, account.currency, user.baseCurrency, fxRate),
        occurredAt, occurredOn: toLocalDate(occurredAt, user.timezone), note: input.note, clientId: input.clientId, recurringId: opts.recurringId,
      })
      .returning();
    return view(row!);
  }

  private async assertCategory(userId: string, categoryId: string, kind: "income" | "expense") {
    const [c] = await this.db.select().from(categories).where(and(eq(categories.id, categoryId), eq(categories.userId, userId), isNull(categories.deletedAt)));
    if (!c) throw unprocessable("invalid_category", "Category not found");
    if (c.kind !== kind) throw unprocessable("category_kind_mismatch", `Category is ${c.kind}, transaction is ${kind}`);
  }

  async createTransfer(userId: string, input: CreateTransferInput) {
    if (input.fromAccountId === input.toAccountId) throw unprocessable("same_account", "Cannot transfer to the same account");
    const [user, from, to] = await Promise.all([this.getUser(userId), this.getAccount(userId, input.fromAccountId), this.getAccount(userId, input.toAccountId)]);
    const sameCurrency = from.currency === to.currency;
    if (!sameCurrency && input.toAmountMinor === undefined) throw unprocessable("to_amount_required", "toAmountMinor is required for cross-currency transfers");
    const toAmount = sameCurrency ? input.amountMinor : input.toAmountMinor!;
    const occurredAt = input.occurredAt ?? new Date();
    const occurredOn = toLocalDate(occurredAt, user.timezone);
    const groupId = randomUUID();
    // Each leg converts to base via its own account currency; the rate applies to the non-base leg(s).
    // An explicit rate is only unambiguous when exactly one leg is non-base; otherwise use stored daily rates.
    const explicitFrom = to.currency === user.baseCurrency ? input.fxRate : undefined;
    const explicitTo = from.currency === user.baseCurrency ? input.fxRate : undefined;
    const rateFrom = await this.fxFor(from.currency, user.baseCurrency, occurredOn, explicitFrom);
    const rateTo = await this.fxFor(to.currency, user.baseCurrency, occurredOn, explicitTo);
    const rows = await this.db
      .insert(transactions)
      .values([
        { userId, accountId: from.id, kind: "transfer_out" as const, amountMinor: input.amountMinor, currency: from.currency, fxRate: String(rateFrom), baseAmountMinor: convertMinor(input.amountMinor, from.currency, user.baseCurrency, rateFrom), occurredAt, occurredOn, note: input.note, transferGroupId: groupId },
        { userId, accountId: to.id, kind: "transfer_in" as const, amountMinor: toAmount, currency: to.currency, fxRate: String(rateTo), baseAmountMinor: convertMinor(toAmount, to.currency, user.baseCurrency, rateTo), occurredAt, occurredOn, note: input.note, transferGroupId: groupId },
      ])
      .returning();
    return { transferGroupId: groupId, legs: rows.map(view) };
  }

  async list(userId: string, q: ListTransactionsInput) {
    const conds: (SQL | undefined)[] = [eq(transactions.userId, userId), isNull(transactions.deletedAt)];
    if (q.from) conds.push(gte(transactions.occurredOn, q.from));
    if (q.to) conds.push(lte(transactions.occurredOn, q.to));
    if (q.accountId) conds.push(eq(transactions.accountId, q.accountId));
    if (q.categoryId) conds.push(eq(transactions.categoryId, q.categoryId));
    if (q.kind) conds.push(eq(transactions.kind, q.kind));
    if (q.minMinor !== undefined) conds.push(gte(transactions.amountMinor, q.minMinor));
    if (q.maxMinor !== undefined) conds.push(lte(transactions.amountMinor, q.maxMinor));
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(transactions.note, like), sql`${transactions.categoryId} in (select id from categories where user_id = ${userId} and name ilike ${like})`));
    }
    if (q.cursor) {
      const [at, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
      const date = new Date(at ?? "");
      if (!id || Number.isNaN(date.getTime())) throw new AppError(400, "invalid_cursor", "Invalid cursor");
      conds.push(sql`(${transactions.occurredAt}, ${transactions.id}) < (${date.toISOString()}::timestamptz, ${id}::uuid)`);
    }
    const rows = await this.db.select().from(transactions).where(and(...conds)).orderBy(desc(transactions.occurredAt), desc(transactions.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > q.limit && last ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`).toString("base64url") : null;
    return { data: page.map(view), meta: { nextCursor } };
  }

  async get(userId: string, id: string) {
    const [t] = await this.db.select().from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    if (!t) throw notFound("Transaction");
    return view(t);
  }

  async update(userId: string, id: string, input: UpdateTransactionInput) {
    const cur = await this.get(userId, id);
    const user = await this.getUser(userId);
    const isTransfer = cur.kind === "transfer_in" || cur.kind === "transfer_out";
    if (isTransfer && (input.amountMinor !== undefined || input.categoryId !== undefined || input.fxRate !== undefined)) {
      throw unprocessable("transfer_immutable", "Delete and recreate a transfer to change its amount");
    }
    const patch: Partial<typeof transactions.$inferInsert> = { updatedAt: new Date(), version: cur.version + 1 };
    if (input.note !== undefined) patch.note = input.note;
    if (input.categoryId !== undefined) {
      if (input.categoryId) await this.assertCategory(userId, input.categoryId, cur.kind as "income" | "expense");
      patch.categoryId = input.categoryId;
    }
    if (input.occurredAt) {
      patch.occurredAt = input.occurredAt;
      patch.occurredOn = toLocalDate(input.occurredAt, user.timezone);
    }
    if (input.amountMinor !== undefined || input.fxRate !== undefined) {
      const rate = input.fxRate ?? cur.fxRate;
      const amount = input.amountMinor ?? cur.amountMinor;
      patch.amountMinor = amount;
      patch.fxRate = String(rate);
      patch.baseAmountMinor = convertMinor(amount, cur.currency, user.baseCurrency, rate);
    }
    const where = isTransfer && cur.transferGroupId ? eq(transactions.transferGroupId, cur.transferGroupId) : eq(transactions.id, id);
    // for transfers only note/date are editable, and apply to both legs
    const set = isTransfer ? { updatedAt: patch.updatedAt, note: patch.note, occurredAt: patch.occurredAt, occurredOn: patch.occurredOn } : patch;
    await this.db.update(transactions).set(set).where(and(where, eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const cur = await this.get(userId, id);
    const where = cur.transferGroupId ? eq(transactions.transferGroupId, cur.transferGroupId) : eq(transactions.id, id);
    await this.db.update(transactions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(where, eq(transactions.userId, userId)));
  }
}
