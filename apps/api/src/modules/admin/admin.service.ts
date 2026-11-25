import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, isNotNull, isNull, max, or, sql, sum, type SQL } from "drizzle-orm";
import type Redis from "ioredis";
import { supportDataKinds, type AdminUsersQuery, type SupportDataKind } from "@moneymgr/shared";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import {
  accounts, assets, attachments, budgets, categories, debts, fxRates, goals, notes, recurringRules, refreshTokens, tags, trades, transactions, users,
} from "../../db/schema";
import { AppError, notFound, unprocessable } from "../../common/errors";
import { KEYS, KV, REDIS, type Keys, type Kv } from "../../infra/kv";
import { AccountsService } from "../accounts/accounts.service";
import { AuthService } from "../auth/auth.service";
import { BudgetsService } from "../budgets/budgets.service";
import { DebtsService } from "../debts/debts";
import { GoalsService } from "../goals/goals";
import { InvestmentsService } from "../investments/investments.service";
import { AccountDeletionService } from "../users/account-deletion.service";
import { AuditService, type AuditActor } from "./audit.service";

type User = typeof users.$inferSelect;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const SUPPORT_LIMIT = 200;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Admin views and actions on customer accounts. Overview data has no financial amounts; amounts only via an audited support view. */
@Injectable()
export class AdminService {
  private readonly log = new Logger("Admin");
  private readonly startedAt = Date.now();
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KV) private readonly kv: Kv,
    @Inject(KEYS) private readonly keys: Keys,
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AccountDeletionService) private readonly deletion: AccountDeletionService,
    @Inject(AccountsService) private readonly accountsSvc: AccountsService,
    @Inject(BudgetsService) private readonly budgetsSvc: BudgetsService,
    @Inject(GoalsService) private readonly goalsSvc: GoalsService,
    @Inject(DebtsService) private readonly debtsSvc: DebtsService,
    @Inject(InvestmentsService) private readonly investmentsSvc: InvestmentsService,
  ) {}

  // ── overview ──

  async stats() {
    const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const live = isNull(users.deletedAt);
    const day = (d: number) => new Date(Date.now() - d * 86_400_000);
    const [total, verified, suspendedN, new7, new30, active30] = await Promise.all([
      n(this.db.select({ n: count() }).from(users).where(live)),
      n(this.db.select({ n: count() }).from(users).where(and(live, isNotNull(users.emailVerifiedAt)))),
      n(this.db.select({ n: count() }).from(users).where(and(live, isNotNull(users.suspendedAt)))),
      n(this.db.select({ n: count() }).from(users).where(and(live, gte(users.createdAt, day(7))))),
      n(this.db.select({ n: count() }).from(users).where(and(live, gte(users.createdAt, day(30))))),
      // "active" = signed in or refreshed a session in the last 30 days
      n(this.db.select({ n: sql<number>`count(distinct ${refreshTokens.userId})` }).from(refreshTokens).where(gte(refreshTokens.createdAt, day(30)))),
    ]);
    const byDay = await this.db.execute<{ date: string; count: number }>(sql`
      select to_char(d, 'YYYY-MM-DD') as date, coalesce(c.n, 0)::int as count
      from generate_series((now() at time zone 'UTC')::date - 29, (now() at time zone 'UTC')::date, interval '1 day') d
      left join (select (created_at at time zone 'UTC')::date as day, count(*) as n from users where deleted_at is null and created_at >= now() - interval '31 days' group by 1) c on c.day = d::date
      order by d`);
    const t = (table: typeof accounts | typeof transactions | typeof budgets | typeof goals | typeof debts | typeof notes | typeof assets | typeof trades) => n(this.db.select({ n: count() }).from(table));
    const [acc, txs, bud, gol, dbt, nts, ast, trd, att] = await Promise.all([
      t(accounts), t(transactions), t(budgets), t(goals), t(debts), t(notes), t(assets), t(trades),
      this.db.select({ n: count(), bytes: sum(attachments.sizeBytes) }).from(attachments),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      users: { total, verified, unverified: total - verified, suspended: suspendedN, newLast7: new7, newLast30: new30, activeLast30: active30 },
      signupsByDay: byDay.rows.map((r) => ({ date: r.date, count: Number(r.count) })),
      totals: { accounts: acc, transactions: txs, budgets: bud, goals: gol, debts: dbt, notes: nts, assets: ast, trades: trd, attachments: Number(att[0]?.n ?? 0), attachmentBytes: Number(att[0]?.bytes ?? 0) },
    };
  }

  private rowSelect() {
    return {
      user: users,
      // correlated subqueries with explicit table names: interpolated columns render unqualified and would bind to the inner table
      lastActiveAt: sql<string | null>`(select max(rt.created_at) from refresh_tokens rt where rt.user_id = "users"."id")`,
      accountCount: sql<number>`(select count(*) from accounts a where a.user_id = "users"."id" and a.deleted_at is null)::int`,
      transactionCount: sql<number>`(select count(*) from transactions t where t.user_id = "users"."id" and t.deleted_at is null)::int`,
    };
  }
  private toRow(r: { user: User; lastActiveAt: string | null; accountCount: number; transactionCount: number }) {
    const u = r.user;
    return {
      id: u.id, email: u.email, name: u.name, baseCurrency: u.baseCurrency, timezone: u.timezone, createdAt: u.createdAt.toISOString(),
      emailVerified: !!u.emailVerifiedAt, suspended: !!u.suspendedAt, suspendedReason: u.suspendedReason ?? null,
      lastActiveAt: iso(r.lastActiveAt), accountCount: Number(r.accountCount), transactionCount: Number(r.transactionCount),
    };
  }

  async listUsers(q: AdminUsersQuery) {
    const where: SQL[] = [isNull(users.deletedAt)];
    if (q.q) { const like = `%${escapeLike(q.q)}%`; where.push(or(ilike(users.email, like), ilike(users.name, like))!); }
    if (q.status === "suspended") where.push(isNotNull(users.suspendedAt));
    if (q.status === "active") where.push(isNull(users.suspendedAt));
    if (q.status === "unverified") where.push(isNull(users.emailVerifiedAt));
    const cond = and(...where);
    const [{ n }] = (await this.db.select({ n: count() }).from(users).where(cond)) as [{ n: number }];
    const rows = await this.db.select(this.rowSelect()).from(users).where(cond).orderBy(desc(users.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => this.toRow(r)), total: Number(n), page: q.page, pageSize: q.pageSize };
  }

  private async userRow(id: string) {
    const [r] = await this.db.select(this.rowSelect()).from(users).where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (!r) throw notFound("User");
    return this.toRow(r);
  }

  async getUser(actor: AuditActor, id: string) {
    const user = await this.userRow(id);
    const c = async (table: typeof accounts | typeof categories | typeof tags | typeof budgets | typeof recurringRules | typeof goals | typeof debts | typeof notes | typeof assets | typeof trades | typeof attachments | typeof transactions) =>
      Number((await this.db.select({ n: count() }).from(table).where(eq((table as typeof accounts).userId, id)))[0]?.n ?? 0);
    const [acc, txs, cat, tg, bud, rec, gol, dbt, nts, ast, trd, att] = await Promise.all([accounts, transactions, categories, tags, budgets, recurringRules, goals, debts, notes, assets, trades, attachments].map(c));
    const [bytes] = await this.db.select({ b: sum(attachments.sizeBytes) }).from(attachments).where(eq(attachments.userId, id));
    const sessions = await this.db.select({ id: refreshTokens.id, userAgent: refreshTokens.userAgent, createdAt: refreshTokens.createdAt, expiresAt: refreshTokens.expiresAt })
      .from(refreshTokens).where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt), gte(refreshTokens.expiresAt, new Date()))).orderBy(desc(refreshTokens.createdAt)).limit(20);
    await this.audit.write(actor, { action: "user.view", targetUserId: id, targetEmail: user.email });
    const ttl = await this.kv.ttl(this.keys.supportGrant(actor.adminId!, id));
    return {
      user,
      counts: { accounts: acc!, transactions: txs!, categories: cat!, tags: tg!, budgets: bud!, recurring: rec!, goals: gol!, debts: dbt!, notes: nts!, assets: ast!, trades: trd!, attachments: att! },
      storageBytes: Number(bytes?.b ?? 0),
      sessions: sessions.map((s) => ({ id: s.id, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString() })),
      recentAudit: await this.audit.forUser(id),
      support: { open: ttl > 0, expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null },
    };
  }

  // ── actions (each one audited with the admin's reason) ──

  async suspend(actor: AuditActor, id: string, reason: string) {
    const before = await this.userRow(id);
    if (before.suspended) throw unprocessable("already_suspended", "This user is already suspended");
    await this.db.update(users).set({ suspendedAt: new Date(), suspendedReason: reason }).where(eq(users.id, id));
    const revoked = await this.revokeSessions(id);
    // live access tokens are refused by the auth guard until they would have expired anyway
    await this.kv.set(this.keys.userSuspended(id), "1", this.config.ACCESS_TOKEN_TTL_SEC + 60);
    await this.audit.write(actor, { action: "user.suspend", targetUserId: id, targetEmail: before.email, reason, meta: { revokedSessions: revoked } });
    return this.userRow(id);
  }

  async reactivate(actor: AuditActor, id: string, reason: string) {
    const before = await this.userRow(id);
    if (!before.suspended) throw unprocessable("not_suspended", "This user isn't suspended");
    await this.db.update(users).set({ suspendedAt: null, suspendedReason: null }).where(eq(users.id, id));
    await this.kv.del(this.keys.userSuspended(id));
    await this.audit.write(actor, { action: "user.reactivate", targetUserId: id, targetEmail: before.email, reason });
    return this.userRow(id);
  }

  async signOut(actor: AuditActor, id: string, reason: string) {
    const u = await this.userRow(id);
    const revoked = await this.revokeSessions(id);
    await this.audit.write(actor, { action: "user.sign_out", targetUserId: id, targetEmail: u.email, reason, meta: { revokedSessions: revoked } });
    return { revokedSessions: revoked };
  }

  async resendVerification(actor: AuditActor, id: string, reason: string) {
    const u = await this.userRow(id);
    if (u.emailVerified) throw unprocessable("already_verified", "This email is already confirmed");
    await this.auth.resendVerification(id);
    await this.audit.write(actor, { action: "user.resend_verification", targetUserId: id, targetEmail: u.email, reason });
    return { accepted: true as const };
  }

  async markVerified(actor: AuditActor, id: string, reason: string) {
    const u = await this.userRow(id);
    if (u.emailVerified) throw unprocessable("already_verified", "This email is already confirmed");
    await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, id));
    await this.audit.write(actor, { action: "user.mark_verified", targetUserId: id, targetEmail: u.email, reason });
    return this.userRow(id);
  }

  async deleteUser(actor: AuditActor, id: string, reason: string, confirmEmail: string) {
    const u = await this.userRow(id);
    if (u.email !== confirmEmail) throw unprocessable("confirm_mismatch", "Type the user's email exactly to confirm");
    // written first: the entry must exist even though the user row is about to disappear
    await this.audit.write(actor, { action: "user.delete", targetUserId: id, targetEmail: u.email, reason, meta: { accounts: u.accountCount, transactions: u.transactionCount } });
    await this.deletion.purge(id);
    await this.kv.del(this.keys.userSuspended(id), this.keys.supportGrant(actor.adminId!, id));
  }

  private async revokeSessions(userId: string) {
    const rows = await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))).returning({ id: refreshTokens.id });
    return rows.length;
  }

  // ── support view: amounts, notes and receipts — only with a reason, time-limited, every read audited ──

  async openSupport(actor: AuditActor, id: string, reason: string) {
    const u = await this.userRow(id);
    const ttl = this.config.ADMIN_SUPPORT_MINUTES * 60;
    await this.kv.set(this.keys.supportGrant(actor.adminId!, id), reason, ttl);
    await this.audit.write(actor, { action: "support.open", targetUserId: id, targetEmail: u.email, reason, meta: { minutes: this.config.ADMIN_SUPPORT_MINUTES } });
    return { userId: id, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async closeSupport(actor: AuditActor, id: string) {
    const u = await this.userRow(id);
    await this.kv.del(this.keys.supportGrant(actor.adminId!, id));
    await this.audit.write(actor, { action: "support.close", targetUserId: id, targetEmail: u.email });
  }

  async supportData(actor: AuditActor, id: string, kind: string) {
    if (!(supportDataKinds as readonly string[]).includes(kind)) throw notFound("Data kind");
    const reason = await this.kv.get(this.keys.supportGrant(actor.adminId!, id));
    if (!reason) throw new AppError(403, "support_view_required", "Open a support view (with a reason) to see this user's data");
    const u = await this.userRow(id);
    const items = await this.readKind(id, kind as SupportDataKind);
    const truncated = items.length > SUPPORT_LIMIT;
    await this.audit.write(actor, { action: "support.read", targetUserId: id, targetEmail: u.email, reason, meta: { kind, rows: Math.min(items.length, SUPPORT_LIMIT) } });
    return { kind, items: JSON.parse(JSON.stringify(items.slice(0, SUPPORT_LIMIT))) as Record<string, unknown>[], truncated };
  }

  private async readKind(userId: string, kind: SupportDataKind): Promise<object[]> {
    const live = <T extends { userId: unknown; deletedAt: unknown }>(t: T) => and(eq(t.userId as typeof users.id, userId), isNull(t.deletedAt as typeof users.deletedAt));
    switch (kind) {
      case "accounts": return this.accountsSvc.list(userId);
      case "transactions": return this.db.select({
        id: transactions.id, occurredOn: transactions.occurredOn, kind: transactions.kind, amountMinor: transactions.amountMinor, currency: transactions.currency,
        baseAmountMinor: transactions.baseAmountMinor, note: transactions.note, accountId: transactions.accountId, categoryId: transactions.categoryId,
        accountName: accounts.name, categoryName: categories.name,
      }).from(transactions).leftJoin(accounts, eq(accounts.id, transactions.accountId)).leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(live(transactions)).orderBy(desc(transactions.occurredAt)).limit(SUPPORT_LIMIT + 1);
      case "categories": return this.db.select().from(categories).where(live(categories)).limit(SUPPORT_LIMIT + 1);
      case "budgets": return this.budgetsSvc.list(userId);
      case "recurring": return this.db.select().from(recurringRules).where(live(recurringRules)).limit(SUPPORT_LIMIT + 1);
      case "goals": return this.goalsSvc.list(userId, false);
      case "debts": return this.debtsSvc.list(userId, "all");
      case "notes": return this.db.select().from(notes).where(eq(notes.userId, userId)).orderBy(desc(notes.updatedAt)).limit(SUPPORT_LIMIT + 1);
      case "investments": return (await this.investmentsSvc.listHoldings(userId, true)).map((h) => ({ ...h.asset, quantity: h.quantity, avgCostMinor: h.avgCostMinor, marketValueMinor: h.marketValueMinor, realisedPnlMinor: h.realisedPnlMinor }));
      case "attachments": return this.db.select({ id: attachments.id, transactionId: attachments.transactionId, fileName: attachments.fileName, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes, createdAt: attachments.createdAt })
        .from(attachments).where(eq(attachments.userId, userId)).orderBy(desc(attachments.createdAt)).limit(SUPPORT_LIMIT + 1);
    }
  }

  // ── system health ──

  async health() {
    const time = async (name: string, fn: () => Promise<string>) => {
      const t0 = performance.now();
      try { const detail = await fn(); return { name, ok: true, latencyMs: Math.round(performance.now() - t0), detail }; }
      catch (e) { return { name, ok: false, latencyMs: null, detail: e instanceof Error ? e.message : "failed" }; }
    };
    const checks = await Promise.all([
      time("Database", async () => { await this.db.execute(sql`select 1`); return "PostgreSQL reachable"; }),
      time("Redis", async () => {
        if (!this.redis) return "not configured — using in-memory store (single instance only)";
        const pong = await this.redis.ping(); if (pong !== "PONG") throw new Error(`unexpected reply ${pong}`); return "PONG";
      }),
      time("Exchange rates", async () => {
        const [r] = await this.db.select({ asOf: max(fxRates.asOf) }).from(fxRates);
        if (!r?.asOf) throw new Error("no rates stored yet");
        const ageDays = Math.floor((Date.now() - new Date(r.asOf).getTime()) / 86_400_000);
        if (ageDays > 3) throw new Error(`latest rates are from ${r.asOf} (${ageDays} days old)`);
        return `latest ${r.asOf}${this.config.FX_AUTO_REFRESH ? ", auto-refresh on" : ", auto-refresh off"}`;
      }),
      time("Email", async () => `transport: ${this.config.MAIL_TRANSPORT}${this.config.MAIL_TRANSPORT === "log" ? " (emails are only printed to the server log)" : ""}`),
      time("Receipt storage", async () => {
        const [s] = await this.db.select({ n: count(), b: sum(attachments.sizeBytes) }).from(attachments);
        return `${Number(s?.n ?? 0)} files, ${(Number(s?.b ?? 0) / 1_048_576).toFixed(1)} MB on local disk (${this.config.UPLOAD_DIR})`;
      }),
    ]);
    // email/storage are informational; database, Redis and FX decide the status
    const status = checks.filter((c) => ["Database", "Redis", "Exchange rates"].includes(c.name)).every((c) => c.ok) ? "ok" : "degraded";
    return { status: status as "ok" | "degraded", checkedAt: new Date().toISOString(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000), node: process.version, checks };
  }
}
