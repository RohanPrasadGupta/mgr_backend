import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { savingsBand, savingsRatePct } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { categories, transactions, users } from "../../db/schema";
import { notFound } from "../../common/errors";

const REAL = ["income", "expense"] as const; // transfers never count as income/expense

@Injectable()
export class InsightsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async baseCurrency(userId: string) {
    const [u] = await this.db.select({ c: users.baseCurrency }).from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u.c;
  }

  private base(userId: string, from: string, to: string) {
    return and(eq(transactions.userId, userId), isNull(transactions.deletedAt), inArray(transactions.kind, [...REAL]), gte(transactions.occurredOn, from), lte(transactions.occurredOn, to));
  }

  async summary(userId: string, from: string, to: string) {
    const baseCurrency = await this.baseCurrency(userId);
    const [r] = await this.db
      .select({
        income: sql<number>`coalesce(sum(${transactions.baseAmountMinor}) filter (where ${transactions.kind} = 'income'), 0)::double precision`,
        expense: sql<number>`coalesce(sum(${transactions.baseAmountMinor}) filter (where ${transactions.kind} = 'expense'), 0)::double precision`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .where(this.base(userId, from, to));
    const incomeMinor = r?.income ?? 0;
    const expenseMinor = r?.expense ?? 0;
    const pct = savingsRatePct(incomeMinor, expenseMinor);
    return { from, to, baseCurrency, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor, savingsRatePct: pct, savingsBand: savingsBand(pct), transactionCount: r?.count ?? 0 };
  }

  async byCategory(userId: string, from: string, to: string, kind: "income" | "expense") {
    const baseCurrency = await this.baseCurrency(userId);
    const rows = await this.db
      .select({
        categoryId: transactions.categoryId,
        name: sql<string>`coalesce(${categories.name}, 'Uncategorised')`,
        totalMinor: sql<number>`sum(${transactions.baseAmountMinor})::double precision`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(and(this.base(userId, from, to), eq(transactions.kind, kind)))
      .groupBy(transactions.categoryId, categories.name)
      .orderBy(sql`sum(${transactions.baseAmountMinor}) desc`);
    const total = rows.reduce((s, r) => s + r.totalMinor, 0);
    return { from, to, kind, baseCurrency, totalMinor: total, items: rows.map((r) => ({ ...r, pct: total ? (r.totalMinor / total) * 100 : 0 })) };
  }

  /** One row per calendar day in the range (zero-filled so charts need no gap handling); transfers excluded. */
  async daily(userId: string, from: string, to: string) {
    const baseCurrency = await this.baseCurrency(userId);
    const rows = await this.db.execute<{ day: string; income: number; expense: number }>(sql`
      select to_char(d.day, 'YYYY-MM-DD') as day,
             coalesce(sum(t.base_amount_minor) filter (where t.kind = 'income'), 0)::double precision as income,
             coalesce(sum(t.base_amount_minor) filter (where t.kind = 'expense'), 0)::double precision as expense
      from generate_series(${from}::date, ${to}::date, interval '1 day') as d(day)
      left join transactions t
        on t.user_id = ${userId} and t.deleted_at is null and t.kind in ('income', 'expense') and t.occurred_on = d.day::date
      group by d.day order by d.day`);
    return { from, to, baseCurrency, days: rows.rows.map((r) => ({ date: r.day, incomeMinor: r.income, expenseMinor: r.expense })) };
  }

  /** v1 `dataPerYear` replacement: 12-element arrays bucketed by the user's local month. */
  async trend(userId: string, year: number) {
    const baseCurrency = await this.baseCurrency(userId);
    const rows = await this.db
      .select({
        month: sql<number>`extract(month from ${transactions.occurredOn})::int`,
        kind: transactions.kind,
        total: sql<number>`sum(${transactions.baseAmountMinor})::double precision`,
      })
      .from(transactions)
      .where(this.base(userId, `${year}-01-01`, `${year}-12-31`))
      .groupBy(sql`extract(month from ${transactions.occurredOn})`, transactions.kind);
    const income = Array<number>(12).fill(0);
    const expense = Array<number>(12).fill(0);
    for (const r of rows) (r.kind === "income" ? income : expense)[r.month - 1] = r.total;
    const net = income.map((v, i) => v - expense[i]!);
    let run = 0;
    const cumulativeNet = net.map((v) => (run += v));
    return { year, baseCurrency, incomeMinor: income, expenseMinor: expense, netMinor: net, cumulativeNetMinor: cumulativeNet };
  }
}
