import { Controller, Get, Inject, Injectable, Query } from "@nestjs/common";
import { daysInMonth, monthRange, reportQuerySchema, savingsRatePct, toLocalDate, type ReportQuery } from "@moneymgr/shared";
import { eq, sql } from "drizzle-orm";
import { DB, type Db } from "../../db/db";
import { users } from "../../db/schema";
import { notFound } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { BudgetsService } from "../budgets/budgets.service";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const n = (v: unknown) => Number(v ?? 0);

/** Period bounds for a report and the one before it (previous month / previous year). */
export function reportWindow(q: ReportQuery) {
  if (q.period === "year") {
    return { label: String(q.year), from: `${q.year}-01-01`, to: `${q.year}-12-31`, previousFrom: `${q.year - 1}-01-01`, previousTo: `${q.year - 1}-12-31` };
  }
  const m = q.month!;
  const cur = monthRange(q.year, m);
  const py = m === 1 ? q.year - 1 : q.year;
  const pm = m === 1 ? 12 : m - 1;
  const prev = monthRange(py, pm);
  return { label: `${FULL[m - 1]} ${q.year}`, from: cur.from, to: cur.to, previousFrom: prev.from, previousTo: prev.to };
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(BudgetsService) private readonly budgets: BudgetsService) {}

  async report(userId: string, q: ReportQuery) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    const w = reportWindow(q);
    const today = toLocalDate(new Date(), u.timezone);
    const live = sql`t.user_id = ${userId} and t.deleted_at is null and t.kind in ('income','expense')`;

    const totals = async (from: string, to: string) => {
      const r = (await this.db.execute(sql`
        select coalesce(sum(base_amount_minor) filter (where kind='income'),0)::double precision as income,
               coalesce(sum(base_amount_minor) filter (where kind='expense'),0)::double precision as expense, count(*)::int as cnt
        from transactions t where ${live} and t.occurred_on between ${from}::date and ${to}::date`)).rows[0] as Record<string, unknown>;
      return { incomeMinor: n(r.income), expenseMinor: n(r.expense), count: n(r.cnt) };
    };
    const byCat = async (kind: "income" | "expense") => {
      const rows = (await this.db.execute(sql`
        select t.category_id as id, coalesce(c.name, 'Uncategorised') as name,
               coalesce(sum(t.base_amount_minor) filter (where t.occurred_on between ${w.from}::date and ${w.to}::date),0)::double precision as cur,
               coalesce(sum(t.base_amount_minor) filter (where t.occurred_on between ${w.previousFrom}::date and ${w.previousTo}::date),0)::double precision as prev
        from transactions t left join categories c on c.id = t.category_id
        where ${live} and t.kind = ${kind} and t.occurred_on between ${w.previousFrom}::date and ${w.to}::date
        group by t.category_id, c.name`)).rows as Record<string, unknown>[];
      const total = rows.reduce((s, r) => s + n(r.cur), 0);
      return rows
        .map((r) => ({ categoryId: (r.id as string | null) ?? null, name: String(r.name), totalMinor: n(r.cur), previousMinor: n(r.prev) }))
        .filter((r) => r.totalMinor > 0 || r.previousMinor > 0)
        .map((r) => ({ ...r, pct: total ? (r.totalMinor / total) * 100 : 0, changePct: r.previousMinor ? ((r.totalMinor - r.previousMinor) / r.previousMinor) * 100 : null }))
        .sort((a, b) => b.totalMinor - a.totalMinor || b.previousMinor - a.previousMinor);
    };

    const [cur, prev, expenseByCategory, incomeByCategory] = await Promise.all([totals(w.from, w.to), totals(w.previousFrom, w.previousTo), byCat("expense"), byCat("income")]);

    const step = q.period === "year" ? sql`interval '1 month'` : sql`interval '1 day'`;
    const seriesRows = (await this.db.execute(sql`
      select to_char(g.d, 'YYYY-MM-DD') as start,
             coalesce(sum(t.base_amount_minor) filter (where t.kind='income'),0)::double precision as income,
             coalesce(sum(t.base_amount_minor) filter (where t.kind='expense'),0)::double precision as expense
      from generate_series(${w.from}::date, ${w.to}::date, ${step}) as g(d)
      left join transactions t on ${live} and ${q.period === "year" ? sql`date_trunc('month', t.occurred_on) = g.d` : sql`t.occurred_on = g.d::date`}
      group by g.d order by g.d`)).rows as Record<string, unknown>[];
    const series = seriesRows.map((r) => {
      const from = String(r.start);
      const [y, m, d] = from.split("-").map(Number) as [number, number, number];
      return q.period === "year"
        ? { label: MONTHS[m - 1]!, from, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`, incomeMinor: n(r.income), expenseMinor: n(r.expense) }
        : { label: String(d), from, to: from, incomeMinor: n(r.income), expenseMinor: n(r.expense) };
    });

    const topExpenses = ((await this.db.execute(sql`
      select t.id, to_char(t.occurred_on, 'YYYY-MM-DD') as day, t.amount_minor, t.currency, t.base_amount_minor, c.name as cat, t.note, a.name as acct
      from transactions t join accounts a on a.id = t.account_id left join categories c on c.id = t.category_id
      where ${live} and t.kind = 'expense' and t.occurred_on between ${w.from}::date and ${w.to}::date
      order by t.base_amount_minor desc, t.occurred_at desc limit 10`)).rows as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), occurredOn: String(r.day), amountMinor: n(r.amount_minor), currency: String(r.currency), baseAmountMinor: n(r.base_amount_minor), categoryName: (r.cat as string | null) ?? null, note: (r.note as string | null) ?? null, accountName: String(r.acct) }));

    const byAccount = ((await this.db.execute(sql`
      select a.id, a.name, a.currency,
             coalesce(sum(t.amount_minor) filter (where t.kind='income'),0)::double precision as income,
             coalesce(sum(t.amount_minor) filter (where t.kind='expense'),0)::double precision as expense
      from transactions t join accounts a on a.id = t.account_id
      where ${live} and t.occurred_on between ${w.from}::date and ${w.to}::date
      group by a.id, a.name, a.currency order by a.name`)).rows as Record<string, unknown>[])
      .map((r) => ({ accountId: String(r.id), name: String(r.name), currency: String(r.currency), incomeMinor: n(r.income), expenseMinor: n(r.expense) }));

    // Budgets as they stood on the period's last day (or today, for the period in progress); nothing for future periods.
    const budgetDay = w.to < today ? w.to : today;
    const budgets = budgetDay < w.from ? [] : (await this.budgets.status(userId, budgetDay)).items
      .map((b) => ({ id: b.id, categoryName: b.categoryName, amountMinor: b.amountMinor, spentMinor: b.spentMinor, pct: b.pct, state: b.state }));

    const elapsedTo = w.to < today ? w.to : today;
    const elapsedDays = elapsedTo < w.from ? 0 : Math.round((Date.parse(elapsedTo) - Date.parse(w.from)) / 86_400_000) + 1;

    return {
      period: q.period, ...w, baseCurrency: u.baseCurrency,
      incomeMinor: cur.incomeMinor, expenseMinor: cur.expenseMinor, netMinor: cur.incomeMinor - cur.expenseMinor,
      savingsRatePct: savingsRatePct(cur.incomeMinor, cur.expenseMinor), transactionCount: cur.count,
      previous: { incomeMinor: prev.incomeMinor, expenseMinor: prev.expenseMinor, netMinor: prev.incomeMinor - prev.expenseMinor },
      avgDailyExpenseMinor: elapsedDays ? Math.round(cur.expenseMinor / elapsedDays) : 0,
      expenseByCategory, incomeByCategory, series, topExpenses, byAccount, budgets,
    };
  }
}

@Controller("reports")
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly svc: ReportsService) {}
  @Get() async get(@UserId() u: string, @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery) { return { data: await this.svc.report(u, q) }; }
}
