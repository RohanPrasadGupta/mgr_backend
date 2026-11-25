import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  convertMinor, toLocalDate,
  type CreateTransactionInput, type CreateTransferInput, type ListTransactionsInput, type UpdateTransactionInput,
} from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { accounts, attachments, categories, tags, transactionTags, transactions, users, type Account } from "../../db/schema";
import { AppError, notFound, unprocessable } from "../../common/errors";
import { FxService } from "../fx/fx.service";
import { AttachmentsService } from "../attachments/attachments";

type Tx = typeof transactions.$inferSelect;
const view = (t: Tx) => ({ ...t, fxRate: Number(t.fxRate) });

@Injectable()
export class TransactionsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(FxService) private readonly fx: FxService, @Inject(AttachmentsService) private readonly files: AttachmentsService) {}

  /** Adds `tagIds` and `attachmentCount` to rows (two batched queries, whatever the page size). */
  private async decorate(rows: Tx[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [tagRows, attRows] = await Promise.all([
      this.db.select({ tx: transactionTags.transactionId, tag: transactionTags.tagId }).from(transactionTags).innerJoin(tags, eq(tags.id, transactionTags.tagId)).where(inArray(transactionTags.transactionId, ids)).orderBy(tags.name),
      this.db.select({ tx: attachments.transactionId, n: sql<number>`count(*)::int` }).from(attachments).where(inArray(attachments.transactionId, ids)).groupBy(attachments.transactionId),
    ]);
    const tagMap = new Map<string, string[]>();
    for (const t of tagRows) (tagMap.get(t.tx) ?? tagMap.set(t.tx, []).get(t.tx)!).push(t.tag);
    const attMap = new Map(attRows.map((a) => [a.tx, a.n]));
    return rows.map((t) => ({ ...view(t), tagIds: tagMap.get(t.id) ?? [], attachmentCount: attMap.get(t.id) ?? 0 }));
  }
  private async one(row: Tx) { return (await this.decorate([row]))[0]!; }

  /** Replace a transaction's tag set; every tag must belong to the user. */
  private async setTags(userId: string, transactionId: string, tagIds: string[]) {
    const unique = [...new Set(tagIds)];
    if (unique.length) {
      const owned = await this.db.select({ id: tags.id }).from(tags).where(and(eq(tags.userId, userId), inArray(tags.id, unique)));
      if (owned.length !== unique.length) throw unprocessable("invalid_tag", "One or more tags were not found");
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId));
      if (unique.length) await tx.insert(transactionTags).values(unique.map((tagId) => ({ transactionId, tagId })));
    });
  }

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
      if (dup) return this.one(dup);
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
    if (input.tagIds?.length) await this.setTags(userId, row!.id, input.tagIds);
    return this.one(row!);
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
    return { transferGroupId: groupId, legs: await this.decorate(rows) };
  }

  async list(userId: string, q: ListTransactionsInput) {
    const conds: (SQL | undefined)[] = [eq(transactions.userId, userId), isNull(transactions.deletedAt)];
    if (q.from) conds.push(gte(transactions.occurredOn, q.from));
    if (q.to) conds.push(lte(transactions.occurredOn, q.to));
    if (q.accountId) conds.push(eq(transactions.accountId, q.accountId));
    if (q.categoryId) conds.push(eq(transactions.categoryId, q.categoryId));
    if (q.kind) conds.push(eq(transactions.kind, q.kind));
    if (q.tagId) conds.push(sql`exists (select 1 from transaction_tags tt where tt.transaction_id = ${transactions.id} and tt.tag_id = ${q.tagId})`);
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
    return { data: await this.decorate(page), meta: { nextCursor } };
  }

  async get(userId: string, id: string) {
    const [t] = await this.db.select().from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    if (!t) throw notFound("Transaction");
    return this.one(t);
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
    if (input.tagIds !== undefined) await this.setTags(userId, id, input.tagIds);
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const cur = await this.get(userId, id);
    const where = cur.transferGroupId ? eq(transactions.transferGroupId, cur.transferGroupId) : eq(transactions.id, id);
    const gone = await this.db.update(transactions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(where, eq(transactions.userId, userId))).returning({ id: transactions.id });
    await this.files.removeForTransactions(userId, gone.map((g) => g.id));
  }
}
