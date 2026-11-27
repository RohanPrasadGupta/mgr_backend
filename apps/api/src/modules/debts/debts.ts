import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  createDebtSchema, debtPaymentSchema, listDebtsSchema, minorUnit, toLocalDate, updateDebtPaymentSchema, updateDebtSchema, type CreateDebtInput, type DebtPaymentInput, type UpdateDebtInput, type UpdateDebtPaymentInput,
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
    const { currency, ...rest } = b;
    const moving = currency !== undefined && currency !== cur.currency;
    if (moving) {
      const [c] = await this.db.select().from(currencies).where(eq(currencies.code, currency));
      if (!c) throw unprocessable("unsupported_currency", `Currency ${currency} is not supported`);
    }
    // A relabel, not a conversion: "NPR 2,000" becomes "THB 2,000". Only the stored minor units follow the new
    // currency's decimals (e.g. NPR 2 → JPY 0), for the principal and every repayment alike.
    const shift = moving ? 10 ** (minorUnit(currency) - minorUnit(cur.currency)) : 1;
    if (rest.principalMinor !== undefined || shift !== 1) {
      const { debt } = await this.get(userId, id);
      const principal = rest.principalMinor ?? Math.round(cur.principalMinor * shift);
      if (principal < Math.round(debt.paidMinor * shift)) throw unprocessable("principal_below_paid", "The amount can't be less than what has already been repaid");
      if (rest.principalMinor === undefined) rest.principalMinor = principal;
    }
    const row = await this.db.transaction(async (tx) => {
      if (shift !== 1) {
        // a power of ten computed above (never user input), written as a numeric literal so Postgres knows its type
        const k = sql.raw(`${shift}::numeric`);
        await tx.update(debtPayments).set({ amountMinor: sql`round(${debtPayments.amountMinor} * ${k})` }).where(eq(debtPayments.debtId, id));
      }
      const [r] = await tx.update(debts).set({ ...rest, ...(moving ? { currency } : {}), updatedAt: new Date() }).where(and(eq(debts.id, id), eq(debts.userId, userId))).returning();
      if (moving) await rememberCurrency(tx, userId, currency);
      return r!;
    });
    return (await this.decorate(userId, [row]))[0]!;
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
  async updatePayment(userId: string, debtId: string, id: string, b: UpdateDebtPaymentInput) {
    const where = and(eq(debtPayments.id, id), eq(debtPayments.debtId, debtId), eq(debtPayments.userId, userId));
    const [cur] = await this.db.select().from(debtPayments).where(where);
    if (!cur) throw notFound("Payment");
    if (b.amountMinor !== undefined && b.amountMinor !== cur.amountMinor) {
      const { debt } = await this.get(userId, debtId);
      // what is left once this payment is taken out, then put back at its new amount
      if (b.amountMinor > debt.outstandingMinor + cur.amountMinor) throw unprocessable("overpayment", "The payment is more than what is still outstanding");
    }
    const [row] = Object.keys(b).length ? await this.db.update(debtPayments).set(b).where(where).returning() : [cur];
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
  @Patch(":id/payments/:pid") async updatePayment(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Param("pid", ParseUUIDPipe) pid: string, @Body(new ZodPipe(updateDebtPaymentSchema)) b: UpdateDebtPaymentInput) { return { data: await this.svc.updatePayment(u, id, pid, b) }; }
  @Delete(":id/payments/:pid") @HttpCode(204) async removePayment(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Param("pid", ParseUUIDPipe) pid: string) { await this.svc.removePayment(u, id, pid); }
}
