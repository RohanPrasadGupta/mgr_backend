import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { budgetWindow, toLocalDate, type CreateBudgetInput, type UpdateBudgetInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { budgets, categories, transactions, users } from "../../db/schema";
import { conflict, notFound, unprocessable } from "../../common/errors";

export type BudgetState = "ok" | "warning" | "over";

@Injectable()
export class BudgetsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async getUser(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u;
  }

  async list(userId: string) {
    return this.db
      .select({ budget: budgets, categoryName: categories.name })
      .from(budgets)
      .leftJoin(categories, eq(categories.id, budgets.categoryId))
      .where(eq(budgets.userId, userId))
      .orderBy(budgets.createdAt)
      .then((rows) => rows.map((r) => ({ ...r.budget, categoryName: r.categoryName })));
  }

  async create(userId: string, input: CreateBudgetInput) {
    const user = await this.getUser(userId);
    if (input.categoryId) {
      const [c] = await this.db.select().from(categories).where(and(eq(categories.id, input.categoryId), eq(categories.userId, userId), isNull(categories.deletedAt)));
      if (!c) throw unprocessable("invalid_category", "Category not found");
      if (c.kind !== "expense") throw unprocessable("category_kind_mismatch", "Budgets apply to expense categories");
    }
    const startOn = input.startOn ?? toLocalDate(new Date(), user.timezone);
    if (input.period !== "custom") {
      const same = await this.db
        .select({ id: budgets.id, endOn: budgets.endOn })
        .from(budgets)
        .where(and(eq(budgets.userId, userId), eq(budgets.period, input.period), input.categoryId ? eq(budgets.categoryId, input.categoryId) : isNull(budgets.categoryId)));
      if (same.some((b) => !b.endOn || b.endOn >= startOn)) throw conflict("budget_exists", "An active budget for this category and period already exists");
    }
    const [row] = await this.db
      .insert(budgets)
      .values({ userId, categoryId: input.categoryId, period: input.period, amountMinor: input.amountMinor, currency: user.baseCurrency, startOn, endOn: input.endOn, alertThresholdPct: input.alertThresholdPct })
      .returning();
    return row!;
  }

  async update(userId: string, id: string, input: UpdateBudgetInput) {
    if (Object.keys(input).length === 0) {
      const [cur] = await this.db.select().from(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId)));
      if (!cur) throw notFound("Budget");
      return cur;
    }
    const [row] = await this.db.update(budgets).set(input).where(and(eq(budgets.id, id), eq(budgets.userId, userId))).returning();
    if (!row) throw notFound("Budget");
    return row;
  }

  async remove(userId: string, id: string) {
    const [row] = await this.db.delete(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId))).returning({ id: budgets.id });
    if (!row) throw notFound("Budget");
  }

  /** Spend vs budget for every budget active on `date` (default: today in the user's timezone). Compared in base currency. */
  async status(userId: string, date?: string) {
    const user = await this.getUser(userId);
    const on = date ?? toLocalDate(new Date(), user.timezone);
    const items = [];
    for (const b of await this.list(userId)) {
      const window = budgetWindow(b.period, on, user.weekStart, b.startOn, b.endOn);
      if (!window) continue;
      const catFilter = b.categoryId
        ? sql`${transactions.categoryId} in (select id from categories where user_id = ${userId} and (id = ${b.categoryId} or parent_id = ${b.categoryId}))`
        : undefined; // overall budget: every expense
      const [r] = await this.db
        .select({ spent: sql<number>`coalesce(sum(${transactions.baseAmountMinor}), 0)::double precision` })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt), eq(transactions.kind, "expense"), gte(transactions.occurredOn, window.from), lte(transactions.occurredOn, window.to), catFilter));
      const spentMinor = r?.spent ?? 0;
      const pct = (spentMinor / b.amountMinor) * 100;
      const state: BudgetState = spentMinor > b.amountMinor ? "over" : pct >= b.alertThresholdPct ? "warning" : "ok";
      items.push({ ...b, window, spentMinor, remainingMinor: b.amountMinor - spentMinor, pct, state });
    }
    return { date: on, baseCurrency: user.baseCurrency, items };
  }
}

