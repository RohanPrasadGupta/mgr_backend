import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, eq, isNull, lte } from "drizzle-orm";
import {
  firstOccurrenceOnOrAfter, nextOccurrence, parseInTimeZone, previewOccurrences, toLocalDate,
  type CreateRecurringInput, type UpdateRecurringInput,
} from "@moneymgr/shared";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { accounts, categories, recurringRules, users } from "../../db/schema";
import { stableUuid } from "../../common/ids";
import { AppError, isUniqueViolation, notFound, unprocessable } from "../../common/errors";
import { TransactionsService } from "../transactions/transactions.service";

type Rule = typeof recurringRules.$inferSelect;
const MAX_CATCH_UP = 366;
const RUN_EVERY_MS = 15 * 60_000;
const anchorDay = (startOn: string) => Number(startOn.slice(8, 10));

export interface RunReport { rules: number; posted: number; errors: { ruleId: string; error: string }[] }

@Injectable()
export class RecurringService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("Recurring");
  private timer?: NodeJS.Timeout;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TransactionsService) private readonly txs: TransactionsService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.RECURRING_AUTO_RUN) return;
    const run = () => this.runDue().then((r) => r.posted && this.log.log(`posted ${r.posted} recurring transaction(s)`)).catch((e) => this.log.error(e));
    void run();
    this.timer = setInterval(run, RUN_EVERY_MS);
    this.timer.unref();
  }
  onApplicationShutdown() { clearInterval(this.timer); }

  private view(r: Rule) {
    return { ...r, nextDates: r.active ? previewOccurrences(r.nextRunOn, r.frequency, r.interval, anchorDay(r.startOn), 3, r.endOn) : [] };
  }

  async list(userId: string) {
    const rows = await this.db.select().from(recurringRules).where(and(eq(recurringRules.userId, userId), isNull(recurringRules.deletedAt))).orderBy(recurringRules.nextRunOn);
    return rows.map((r) => this.view(r));
  }

  private async getRule(userId: string, id: string) {
    const [r] = await this.db.select().from(recurringRules).where(and(eq(recurringRules.id, id), eq(recurringRules.userId, userId), isNull(recurringRules.deletedAt)));
    if (!r) throw notFound("Recurring rule");
    return r;
  }

  async get(userId: string, id: string) { return this.view(await this.getRule(userId, id)); }

  async create(userId: string, input: CreateRecurringInput) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    const [acct] = await this.db.select().from(accounts).where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId), isNull(accounts.deletedAt)));
    if (!acct) throw unprocessable("invalid_account", "Account not found");
    if (input.categoryId) await this.assertCategory(userId, input.categoryId, input.kind);
    const today = toLocalDate(new Date(), user.timezone);
    const nextRunOn = input.backfill || input.startOn >= today ? input.startOn : firstOccurrenceOnOrAfter(input.startOn, input.frequency, input.interval, today);
    if (input.endOn && nextRunOn > input.endOn) throw unprocessable("nothing_to_schedule", "No occurrence falls between today and endOn");
    const [row] = await this.db
      .insert(recurringRules)
      .values({ userId, accountId: input.accountId, categoryId: input.categoryId, kind: input.kind, amountMinor: input.amountMinor, note: input.note, frequency: input.frequency, interval: input.interval, startOn: input.startOn, endOn: input.endOn, nextRunOn })
      .returning();
    return this.view(row!);
  }

  private async assertCategory(userId: string, categoryId: string, kind: "income" | "expense") {
    const [c] = await this.db.select().from(categories).where(and(eq(categories.id, categoryId), eq(categories.userId, userId), isNull(categories.deletedAt)));
    if (!c) throw unprocessable("invalid_category", "Category not found");
    if (c.kind !== kind) throw unprocessable("category_kind_mismatch", `Category is ${c.kind}, rule is ${kind}`);
  }

  async update(userId: string, id: string, input: UpdateRecurringInput) {
    const cur = await this.getRule(userId, id);
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (input.categoryId) await this.assertCategory(userId, input.categoryId, cur.kind);
    const patch: Partial<typeof recurringRules.$inferInsert> = { ...input };
    if (input.frequency || input.interval) {
      const today = toLocalDate(new Date(), user!.timezone);
      patch.nextRunOn = firstOccurrenceOnOrAfter(cur.startOn, input.frequency ?? cur.frequency, input.interval ?? cur.interval, today);
    }
    if (input.active === true) { patch.lastError = null; if (cur.nextRunOn < toLocalDate(new Date(), user!.timezone)) patch.nextRunOn = firstOccurrenceOnOrAfter(cur.startOn, input.frequency ?? cur.frequency, input.interval ?? cur.interval, toLocalDate(new Date(), user!.timezone)); }
    if (Object.keys(patch).length === 0) return this.view(cur);
    const [row] = await this.db.update(recurringRules).set(patch).where(eq(recurringRules.id, id)).returning();
    return this.view(row!);
  }

  async remove(userId: string, id: string) {
    await this.getRule(userId, id);
    await this.db.update(recurringRules).set({ deletedAt: new Date(), active: false }).where(eq(recurringRules.id, id));
  }

  /**
   * Post every occurrence that is due (≤ today in each rule owner's timezone). Safe to call repeatedly or from
   * several instances: each occurrence has a deterministic clientId, so it can only ever be created once.
   */
  async runDue(opts: { userId?: string; now?: Date } = {}): Promise<RunReport> {
    const now = opts.now ?? new Date();
    const horizon = new Date(now.getTime() + 36 * 3600_000).toISOString().slice(0, 10); // covers every timezone
    const rows = await this.db
      .select({ rule: recurringRules, timezone: users.timezone })
      .from(recurringRules)
      .innerJoin(users, eq(users.id, recurringRules.userId))
      .where(and(eq(recurringRules.active, true), isNull(recurringRules.deletedAt), lte(recurringRules.nextRunOn, horizon), opts.userId ? eq(recurringRules.userId, opts.userId) : undefined));
    const report: RunReport = { rules: 0, posted: 0, errors: [] };
    for (const { rule, timezone } of rows) {
      const today = toLocalDate(now, timezone);
      if (rule.nextRunOn > today) continue;
      report.rules++;
      const r = await this.runRule(rule, timezone, today);
      report.posted += r.posted;
      if (r.error) report.errors.push({ ruleId: rule.id, error: r.error });
    }
    return report;
  }

  private async runRule(rule: Rule, timezone: string, today: string) {
    let next = rule.nextRunOn;
    let posted = 0;
    let lastRun = rule.lastRunOn;
    let error: string | null = null;
    for (let i = 0; i < MAX_CATCH_UP && next <= today && (!rule.endOn || next <= rule.endOn); i++) {
      try {
        await this.txs.create(
          rule.userId,
          { accountId: rule.accountId, kind: rule.kind, amountMinor: rule.amountMinor, categoryId: rule.categoryId ?? undefined, note: rule.note ?? undefined, occurredAt: parseInTimeZone(`${next} 12:00`, timezone)!, clientId: stableUuid(`recurring:${rule.id}:${next}`) },
          { recurringId: rule.id },
        );
        posted++;
      } catch (e) {
        if (!isUniqueViolation(e)) { // 23505 = already posted by a concurrent run; fine
          error = e instanceof AppError ? e.message : "unexpected error";
          if (!(e instanceof AppError)) this.log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
          break;
        }
      }
      lastRun = next;
      next = nextOccurrence(next, rule.frequency, rule.interval, anchorDay(rule.startOn));
    }
    const finished = !!rule.endOn && next > rule.endOn;
    await this.db.update(recurringRules).set({ nextRunOn: next, lastRunOn: lastRun, lastError: error, active: finished ? false : rule.active }).where(eq(recurringRules.id, rule.id));
    return { posted, error };
  }
}
