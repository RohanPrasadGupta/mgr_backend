import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createGoalSchema, goalContributionSchema, toLocalDate, updateGoalSchema, type CreateGoalInput, type GoalContributionInput, type UpdateGoalInput } from "@moneymgr/shared";
import { z } from "zod";
import { DB, type Db } from "../../db/db";
import { accounts, goalContributions, goals, transactions, users } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";

type GoalRow = typeof goals.$inferSelect;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Pure progress maths, exported for unit tests. */
export function goalProgress(g: Pick<GoalRow, "targetMinor" | "targetDate" | "createdAt">, savedMinor: number, today: string) {
  const remainingMinor = Math.max(0, g.targetMinor - savedMinor);
  const pct = Math.max(0, (savedMinor / g.targetMinor) * 100);
  if (savedMinor >= g.targetMinor) return { remainingMinor: 0, pct, monthlyNeededMinor: null, status: "reached" as const };
  if (!g.targetDate) return { remainingMinor, pct, monthlyNeededMinor: null, status: "no_deadline" as const };
  if (g.targetDate < today) return { remainingMinor, pct, monthlyNeededMinor: null, status: "overdue" as const };
  const daysLeft = daysBetween(today, g.targetDate);
  const monthsLeft = Math.max(1, Math.ceil(daysLeft / 30.4375));
  const start = g.createdAt.toISOString().slice(0, 10);
  const total = Math.max(1, daysBetween(start, g.targetDate));
  const expectedPct = Math.min(100, (Math.max(0, daysBetween(start, today)) / total) * 100);
  return { remainingMinor, pct, monthlyNeededMinor: Math.ceil(remainingMinor / monthsLeft), status: pct + 0.5 >= expectedPct ? ("on_track" as const) : ("behind" as const) };
}

@Injectable()
export class GoalsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async user(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u;
  }
  private async account(userId: string, id: string) {
    const [a] = await this.db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId), isNull(accounts.deletedAt)));
    if (!a) throw unprocessable("invalid_account", "Account not found");
    return a;
  }

  /** Saved amount per goal: linked account balance (its own currency) or the sum of contributions. */
  private async decorate(userId: string, rows: GoalRow[]) {
    if (!rows.length) return [];
    const u = await this.user(userId);
    const today = toLocalDate(new Date(), u.timezone);
    const ids = rows.map((g) => g.id);
    const acctIds = rows.map((g) => g.accountId).filter((x): x is string => !!x);
    const contrib = await this.db.select({ goalId: goalContributions.goalId, total: sql<number>`sum(${goalContributions.amountMinor})::double precision` }).from(goalContributions).where(inArray(goalContributions.goalId, ids)).groupBy(goalContributions.goalId);
    const balances = acctIds.length
      ? await this.db
        .select({ id: accounts.id, balance: sql<number>`(${accounts.openingBalanceMinor} + coalesce(sum(case when ${transactions.kind} in ('income','transfer_in') then ${transactions.amountMinor} else -${transactions.amountMinor} end), 0))::double precision` })
        .from(accounts).leftJoin(transactions, and(eq(transactions.accountId, accounts.id), isNull(transactions.deletedAt)))
        .where(inArray(accounts.id, acctIds)).groupBy(accounts.id)
      : [];
    const c = new Map(contrib.map((x) => [x.goalId, x.total]));
    const b = new Map(balances.map((x) => [x.id, x.balance]));
    return rows.map((g) => {
      const source = g.accountId && b.has(g.accountId) ? ("account" as const) : ("contributions" as const);
      const savedMinor = source === "account" ? b.get(g.accountId!)! : (c.get(g.id) ?? 0);
      return { ...g, source, savedMinor, ...goalProgress(g, savedMinor, today) };
    });
  }

  async list(userId: string, archived?: boolean) {
    const rows = await this.db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.archived, archived ?? false))).orderBy(goals.targetDate, goals.createdAt);
    return this.decorate(userId, rows);
  }
  private async row(userId: string, id: string) {
    const [g] = await this.db.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, userId)));
    if (!g) throw notFound("Goal");
    return g;
  }
  async get(userId: string, id: string) {
    const [goal] = await this.decorate(userId, [await this.row(userId, id)]);
    const contributions = (await this.db.select().from(goalContributions).where(eq(goalContributions.goalId, id)).orderBy(desc(goalContributions.occurredOn), desc(goalContributions.createdAt)))
      .map(({ userId: _u, ...c }) => c);
    return { goal: goal!, contributions };
  }
  async create(userId: string, b: CreateGoalInput) {
    const u = await this.user(userId);
    let currency = b.currency ?? u.baseCurrency;
    if (b.accountId) {
      const a = await this.account(userId, b.accountId);
      if (b.currency && b.currency !== a.currency) throw unprocessable("currency_mismatch", `The linked account is in ${a.currency}`);
      currency = a.currency;
    }
    const [row] = await this.db.insert(goals).values({ userId, ...b, currency }).returning();
    return (await this.decorate(userId, [row!]))[0]!;
  }
  async update(userId: string, id: string, b: UpdateGoalInput) {
    const cur = await this.row(userId, id);
    if (b.accountId) {
      const a = await this.account(userId, b.accountId);
      if (a.currency !== cur.currency) throw unprocessable("currency_mismatch", `The goal is in ${cur.currency} but the account is in ${a.currency}`);
    }
    const [row] = await this.db.update(goals).set({ ...b, updatedAt: new Date() }).where(and(eq(goals.id, id), eq(goals.userId, userId))).returning();
    return (await this.decorate(userId, [row!]))[0]!;
  }
  async remove(userId: string, id: string) {
    const [row] = await this.db.delete(goals).where(and(eq(goals.id, id), eq(goals.userId, userId))).returning({ id: goals.id });
    if (!row) throw notFound("Goal");
  }
  async contribute(userId: string, id: string, b: GoalContributionInput) {
    const g = await this.row(userId, id);
    if (g.accountId) throw unprocessable("goal_linked_to_account", "This goal tracks an account balance — add money to the account instead");
    const u = await this.user(userId);
    const [row] = await this.db.insert(goalContributions).values({ userId, goalId: id, amountMinor: b.amountMinor, occurredOn: b.occurredOn ?? toLocalDate(new Date(), u.timezone), note: b.note }).returning();
    const { userId: _u, ...c } = row!;
    return c;
  }
  async removeContribution(userId: string, goalId: string, id: string) {
    const [row] = await this.db.delete(goalContributions).where(and(eq(goalContributions.id, id), eq(goalContributions.goalId, goalId), eq(goalContributions.userId, userId))).returning({ id: goalContributions.id });
    if (!row) throw notFound("Contribution");
  }
}

const archivedQuery = z.object({ archived: z.enum(["true", "false"]).optional() });

@Controller("goals")
export class GoalsController {
  constructor(@Inject(GoalsService) private readonly svc: GoalsService) {}
  @Get() async list(@UserId() u: string, @Query(new ZodPipe(archivedQuery)) q: { archived?: "true" | "false" }) { return { data: await this.svc.list(u, q.archived === "true") }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createGoalSchema)) b: CreateGoalInput) { return { data: await this.svc.create(u, b) }; }
  @Get(":id") async get(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.get(u, id) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateGoalSchema)) b: UpdateGoalInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
  @Post(":id/contributions") async contribute(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(goalContributionSchema)) b: GoalContributionInput) { return { data: await this.svc.contribute(u, id, b) }; }
  @Delete(":id/contributions/:cid") @HttpCode(204) async removeContribution(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Param("cid", ParseUUIDPipe) cid: string) { await this.svc.removeContribution(u, id, cid); }
}
