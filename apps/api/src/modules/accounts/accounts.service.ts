import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { CreateAccountInput, UpdateAccountInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { accounts, currencies, recurringRules, transactions } from "../../db/schema";
import { conflict, notFound, unprocessable } from "../../common/errors";

@Injectable()
export class AccountsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private balanceQuery(userId: string) {
    // balance = opening + income + transfer_in − expense − transfer_out, in the account's own currency
    return this.db
      .select({
        ...getTableColumns(accounts),
        balanceMinor: sql<number>`(${accounts.openingBalanceMinor} + coalesce(sum(case when ${transactions.kind} in ('income','transfer_in') then ${transactions.amountMinor} else -${transactions.amountMinor} end), 0))::double precision`,
      })
      .from(accounts)
      .leftJoin(transactions, and(eq(transactions.accountId, accounts.id), isNull(transactions.deletedAt)))
      .where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)))
      .groupBy(accounts.id)
      .orderBy(asc(accounts.sort), asc(accounts.createdAt));
  }

  list(userId: string) {
    return this.balanceQuery(userId);
  }

  async get(userId: string, id: string) {
    const row = (await this.balanceQuery(userId)).find((a) => a.id === id);
    if (!row) throw notFound("Account");
    return row;
  }

  async create(userId: string, input: CreateAccountInput) {
    const [cur] = await this.db.select().from(currencies).where(eq(currencies.code, input.currency));
    if (!cur) throw unprocessable("unsupported_currency", `Currency ${input.currency} is not supported`);
    const [row] = await this.db.insert(accounts).values({ ...input, userId }).returning();
    return this.get(userId, row!.id);
  }

  async update(userId: string, id: string, input: UpdateAccountInput) {
    const [row] = await this.db
      .update(accounts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId), isNull(accounts.deletedAt)))
      .returning({ id: accounts.id });
    if (!row) throw notFound("Account");
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const [used] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.accountId, id), eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    if ((used?.n ?? 0) > 0) throw conflict("account_has_transactions", "Account has transactions; archive it instead");
    const [rule] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(recurringRules)
      .where(and(eq(recurringRules.accountId, id), eq(recurringRules.userId, userId), eq(recurringRules.active, true), isNull(recurringRules.deletedAt)));
    if ((rule?.n ?? 0) > 0) throw conflict("account_has_recurring", "Account has active recurring rules; delete or pause them first");
    const [row] = await this.db
      .update(accounts)
      .set({ deletedAt: new Date() })
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId), isNull(accounts.deletedAt)))
      .returning({ id: accounts.id });
    if (!row) throw notFound("Account");
  }
}
