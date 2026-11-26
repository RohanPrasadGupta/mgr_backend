import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  createDebtSchema, debtPaymentSchema, listDebtsSchema, toLocalDate, updateDebtSchema, type CreateDebtInput, type DebtPaymentInput, type UpdateDebtInput,
} from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { currencies, debtPayments, debts, users } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { rememberCurrency } from "../users/user-currencies";

type DebtRow = typeof debts.$inferSelect;

@Injectable()
export class DebtsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async user(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u;
  }
  private async decorate(userId: string, rows: DebtRow[]) {
    if (!rows.length) return [];
    const today = toLocalDate(new Date(), (await this.user(userId)).timezone);
    const paid = await this.db
      .select({ debtId: debtPayments.debtId, total: sql<number>`sum(${debtPayments.amountMinor})::double precision`, last: sql<string | null>`to_char(max(${debtPayments.paidOn}), 'YYYY-MM-DD')` })
      .from(debtPayments).where(inArray(debtPayments.debtId, rows.map((d) => d.id))).groupBy(debtPayments.debtId);
    const m = new Map(paid.map((p) => [p.debtId, p]));
    return rows.map((d) => {
      const paidMinor = m.get(d.id)?.total ?? 0;
      const outstandingMinor = Math.max(0, d.principalMinor - paidMinor);
      const status = outstandingMinor === 0 ? ("settled" as const) : d.dueOn && d.dueOn < today ? ("overdue" as const) : ("open" as const);
      return { ...d, paidMinor, outstandingMinor, status, lastPaidOn: m.get(d.id)?.last ?? null };
    });
  }
  private async row(userId: string, id: string) {
    const [d] = await this.db.select().from(debts).where(and(eq(debts.id, id), eq(debts.userId, userId)));
    if (!d) throw notFound("Debt");
    return d;
  }
  async list(userId: string, status: "open" | "settled" | "all") {
    const all = await this.decorate(userId, await this.db.select().from(debts).where(eq(debts.userId, userId)).orderBy(debts.dueOn, desc(debts.startedOn)));
    return all.filter((d) => status === "all" || (status === "settled" ? d.status === "settled" : d.status !== "settled"));
  }
  async summary(userId: string) {
    const open = await this.list(userId, "open");
    const by = new Map<string, { currency: string; owedToMeMinor: number; iOweMinor: number }>();
    for (const d of open) {
      const t = by.get(d.currency) ?? { currency: d.currency, owedToMeMinor: 0, iOweMinor: 0 };
      if (d.direction === "lent") t.owedToMeMinor += d.outstandingMinor; else t.iOweMinor += d.outstandingMinor;
      by.set(d.currency, t);
    }
    return {
      totals: [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((t) => ({ ...t, netMinor: t.owedToMeMinor - t.iOweMinor })),
      openCount: open.length, overdueCount: open.filter((d) => d.status === "overdue").length,
    };
  }
  async get(userId: string, id: string) {
    const [debt] = await this.decorate(userId, [await this.row(userId, id)]);
    const payments = (await this.db.select().from(debtPayments).where(eq(debtPayments.debtId, id)).orderBy(desc(debtPayments.paidOn), desc(debtPayments.createdAt))).map(({ userId: _u, ...p }) => p);
    return { debt: debt!, payments };
  }
  async create(userId: string, b: CreateDebtInput) {
    const u = await this.user(userId);
    const currency = b.currency ?? u.baseCurrency;
    const [c] = await this.db.select().from(currencies).where(eq(currencies.code, currency));
    if (!c) throw unprocessable("unsupported_currency", `Currency ${currency} is not supported`);
    const [row] = await this.db.insert(debts).values({ userId, ...b, currency, startedOn: b.startedOn ?? toLocalDate(new Date(), u.timezone) }).returning();
    await rememberCurrency(this.db, userId, currency);
    return (await this.decorate(userId, [row!]))[0]!;
  }
  async update(userId: string, id: string, b: UpdateDebtInput) {
    const cur = await this.row(userId, id);
    if (b.dueOn && b.dueOn < cur.startedOn) throw unprocessable("invalid_due_date", "dueOn must be on or after the start date");
    if (b.principalMinor !== undefined) {
      const { debt } = await this.get(userId, id);
      if (b.principalMinor < debt.paidMinor) throw unprocessable("principal_below_paid", "The amount can't be less than what has already been repaid");
    }
    const [row] = await this.db.update(debts).set({ ...b, updatedAt: new Date() }).where(and(eq(debts.id, id), eq(debts.userId, userId))).returning();
    return (await this.decorate(userId, [row!]))[0]!;
  }
  async remove(userId: string, id: string) {
    const [row] = await this.db.delete(debts).where(and(eq(debts.id, id), eq(debts.userId, userId))).returning({ id: debts.id });
    if (!row) throw notFound("Debt");
  }
  async pay(userId: string, id: string, b: DebtPaymentInput) {
    const { debt } = await this.get(userId, id);
    if (b.amountMinor > debt.outstandingMinor) throw unprocessable("overpayment", debt.outstandingMinor === 0 ? "This debt is already settled" : "The payment is more than what is still outstanding");
    const u = await this.user(userId);
    const [row] = await this.db.insert(debtPayments).values({ userId, debtId: id, amountMinor: b.amountMinor, paidOn: b.paidOn ?? toLocalDate(new Date(), u.timezone), note: b.note }).returning();
    const { userId: _u, ...p } = row!;
    return p;
  }
  async removePayment(userId: string, debtId: string, id: string) {
    const [row] = await this.db.delete(debtPayments).where(and(eq(debtPayments.id, id), eq(debtPayments.debtId, debtId), eq(debtPayments.userId, userId))).returning({ id: debtPayments.id });
    if (!row) throw notFound("Payment");
  }
}

@Controller("debts")
export class DebtsController {
  constructor(@Inject(DebtsService) private readonly svc: DebtsService) {}
  @Get() async list(@UserId() u: string, @Query(new ZodPipe(listDebtsSchema)) q: { status: "open" | "settled" | "all" }) { return { data: await this.svc.list(u, q.status) }; }
  @Get("summary") async summary(@UserId() u: string) { return { data: await this.svc.summary(u) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createDebtSchema)) b: CreateDebtInput) { return { data: await this.svc.create(u, b) }; }
  @Get(":id") async get(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.get(u, id) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateDebtSchema)) b: UpdateDebtInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
  @Post(":id/payments") async pay(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(debtPaymentSchema)) b: DebtPaymentInput) { return { data: await this.svc.pay(u, id, b) }; }
  @Delete(":id/payments/:pid") @HttpCode(204) async removePayment(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Param("pid", ParseUUIDPipe) pid: string) { await this.svc.removePayment(u, id, pid); }
}
