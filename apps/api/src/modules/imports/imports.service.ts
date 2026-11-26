import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { convertMinor, importCategoryRowSchema, importRowSchema, parseInTimeZone, toLocalDate, toMinor, type ImportRow } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { accounts, categories, transactions, users } from "../../db/schema";
import { notFound } from "../../common/errors";
import { stableUuid } from "../../common/ids";
import { FxService } from "../fx/fx.service";

type Kind = "income" | "expense";
export interface ImportReport {
  dryRun: boolean;
  total: number;
  imported: number;
  duplicates: number;
  invalid: { row: number; reason: string }[];
  createdAccounts: string[];
  createdCategories: string[];
  approximateFxRows: number;
}

export interface CategoryImportReport { dryRun: boolean; total: number; imported: number; duplicates: number; invalid: { row: number; reason: string }[]; created: string[] }

const LEADING_EMOJI = /^((?:\p{Extended_Pictographic}|️|‍)+)\s*/u;

/** "🍜 Food" → { icon: "🍜", name: "Food" }; names without an emoji pass through. */
export function splitEmoji(raw: string): { icon: string | null; name: string } {
  const s = raw.trim();
  const m = LEADING_EMOJI.exec(s);
  if (!m) return { icon: null, name: s };
  const name = s.slice(m[0].length).trim();
  return name ? { icon: m[1]!.slice(0, 40), name } : { icon: null, name: s };
}

const guessAccountType = (name: string) =>
  /cash/i.test(name) ? "cash" : /card|credit/i.test(name) ? "card" : /bank/i.test(name) ? "bank" : "wallet";

@Injectable()
export class ImportsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(FxService) private readonly fx: FxService) {}

  /**
   * Categories on their own (before their transactions, so each keeps its emoji icon). Matched like the transaction
   * importer matches them — same kind, name ignoring case and the emoji — so neither import ever creates a second copy.
   * An existing category without an icon (e.g. the defaults every account starts with) takes the imported emoji.
   */
  async importCategories(userId: string, rawRows: unknown[], dryRun: boolean): Promise<CategoryImportReport> {
    const report: CategoryImportReport = { dryRun, total: rawRows.length, imported: 0, duplicates: 0, invalid: [], created: [] };
    const existing = await this.db.select({ id: categories.id, kind: categories.kind, name: categories.name, icon: categories.icon }).from(categories).where(and(eq(categories.userId, userId), isNull(categories.deletedAt)));
    const byKey = new Map(existing.map((c) => [`${c.kind}|${c.name.toLowerCase()}`, c]));
    const seen = new Set(byKey.keys());
    const values: (typeof categories.$inferInsert)[] = [];
    const icons: { id: string; icon: string }[] = []; // existing categories without an icon take the imported one
    rawRows.forEach((raw, i) => {
      const p = importCategoryRowSchema.safeParse(raw);
      if (!p.success) return void report.invalid.push({ row: i + 1, reason: p.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      const kind: Kind = p.data.type === "Income" ? "income" : "expense";
      const { icon, name } = splitEmoji(p.data.name);
      const key = `${kind}|${name.toLowerCase()}`;
      if (seen.has(key)) {
        const hit = byKey.get(key);
        if (hit && !hit.icon && icon) { icons.push({ id: hit.id, icon }); hit.icon = icon; }
        return void report.duplicates++;
      }
      seen.add(key);
      values.push({ userId, name: name.slice(0, 60), kind, icon });
      report.created.push(`${kind}:${name}`);
    });
    if (!dryRun && (values.length || icons.length)) {
      await this.db.transaction(async (tx) => {
        if (values.length) await tx.insert(categories).values(values);
        for (const { id, icon } of icons) await tx.update(categories).set({ icon }).where(and(eq(categories.id, id), eq(categories.userId, userId)));
      });
    }
    report.imported = values.length;
    return report;
  }

  async importTransactions(userId: string, rawRows: unknown[], dryRun: boolean): Promise<ImportReport> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    const report: ImportReport = { dryRun, total: rawRows.length, imported: 0, duplicates: 0, invalid: [], createdAccounts: [], createdCategories: [], approximateFxRows: 0 };

    // 1) validate + normalise
    const rows: { idx: number; row: ImportRow; at: Date; amountMinor: number }[] = [];
    rawRows.forEach((raw, i) => {
      const p = importRowSchema.safeParse(raw);
      if (!p.success) return void report.invalid.push({ row: i + 1, reason: p.error.issues[0] ? `${p.error.issues[0].path.join(".")}: ${p.error.issues[0].message}` : "invalid row" });
      const at = parseInTimeZone(p.data.date, user.timezone);
      if (!at) return void report.invalid.push({ row: i + 1, reason: `date: unrecognised format "${p.data.date}"` });
      const amountMinor = toMinor(p.data.amount, p.data.currency);
      if (amountMinor <= 0) return void report.invalid.push({ row: i + 1, reason: "amount rounds to zero" });
      rows.push({ idx: i + 1, row: p.data, at, amountMinor });
    });

    return this.db.transaction(async (tx) => {
      // 2) resolve accounts per (name, currency)
      const existingAccts = await tx.select().from(accounts).where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)));
      const acctByKey = new Map(existingAccts.map((a) => [`${a.name}|${a.currency}`, a.id]));
      const takenNames = new Set(existingAccts.map((a) => a.name));
      const acctIds = new Map<string, string>(); // `${name}|${cur}` (import) -> account id (or placeholder in dry run)
      for (const { row } of rows) {
        const key = `${row.account}|${row.currency}`;
        if (acctIds.has(key)) continue;
        const hit = acctByKey.get(key);
        if (hit) { acctIds.set(key, hit); continue; }
        const name = takenNames.has(row.account) ? `${row.account} (${row.currency})` : row.account;
        const reuse = acctByKey.get(`${name}|${row.currency}`);
        if (reuse) { acctIds.set(key, reuse); continue; }
        takenNames.add(name);
        report.createdAccounts.push(name);
        if (dryRun) { acctIds.set(key, `dry:${name}`); continue; }
        const [a] = await tx.insert(accounts).values({ userId, name, type: guessAccountType(row.account), currency: row.currency }).returning({ id: accounts.id });
        acctByKey.set(`${name}|${row.currency}`, a!.id);
        acctIds.set(key, a!.id);
      }

      // 3) resolve categories per (kind, cleaned name)
      const existingCats = await tx.select().from(categories).where(and(eq(categories.userId, userId), isNull(categories.deletedAt)));
      const catByKey = new Map(existingCats.map((c) => [`${c.kind}|${c.name.toLowerCase()}`, c.id]));
      const catIds = new Map<string, string | null>();
      for (const { row } of rows) {
        const kind: Kind = row.type === "Income" ? "income" : "expense";
        const { icon, name } = splitEmoji(row.category);
        const key = `${kind}|${name.toLowerCase()}`;
        if (!name || catIds.has(key)) continue;
        const hit = catByKey.get(key);
        if (hit) { catIds.set(key, hit); continue; }
        report.createdCategories.push(`${kind}:${name}`);
        if (dryRun) { catIds.set(key, `dry:${key}`); continue; }
        const [c] = await tx.insert(categories).values({ userId, name: name.slice(0, 60), kind, icon }).returning({ id: categories.id });
        catByKey.set(key, c!.id);
        catIds.set(key, c!.id);
      }

      // 4) build transactions
      const fxCache = new Map<string, { rate: number; approximate: boolean } | null>();
      const occurrences = new Map<string, number>();
      const values: (typeof transactions.$inferInsert)[] = [];
      for (const { idx, row, at, amountMinor } of rows) {
        const occurredOn = toLocalDate(at, user.timezone);
        let rate = 1;
        if (row.currency !== user.baseCurrency) {
          const ck = `${row.currency}|${occurredOn}`;
          if (!fxCache.has(ck)) fxCache.set(ck, await this.fx.getRate(row.currency, user.baseCurrency, occurredOn));
          const q = fxCache.get(ck);
          if (!q) { report.invalid.push({ row: idx, reason: `no FX rate for ${row.currency}→${user.baseCurrency}` }); continue; }
          if (q.approximate) report.approximateFxRows++;
          rate = q.rate;
        }
        const { name: catName } = splitEmoji(row.category);
        const kind: Kind = row.type === "Income" ? "income" : "expense";
        const seed = [userId, at.toISOString(), row.account, row.currency, row.type, amountMinor, row.category, row.note].join("|");
        const n = (occurrences.get(seed) ?? 0) + 1;
        occurrences.set(seed, n);
        const accountId = acctIds.get(`${row.account}|${row.currency}`)!;
        const categoryId = catName ? (catIds.get(`${kind}|${catName.toLowerCase()}`) ?? null) : null;
        values.push({
          userId, accountId, categoryId: dryRun ? null : categoryId, kind, amountMinor, currency: row.currency,
          fxRate: String(rate), baseAmountMinor: convertMinor(amountMinor, row.currency, user.baseCurrency, rate),
          occurredAt: at, occurredOn, note: row.note || null, clientId: stableUuid(`${seed}|${n}`),
        });
      }

      // 5) dedupe against what's already stored, then insert in chunks
      const ids = values.map((v) => v.clientId!);
      const existing = new Set<string>();
      for (let i = 0; i < ids.length; i += 1000) {
        const found = await tx.select({ c: transactions.clientId }).from(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.clientId, ids.slice(i, i + 1000))));
        found.forEach((f) => f.c && existing.add(f.c));
      }
      const fresh = values.filter((v) => !existing.has(v.clientId!));
      report.duplicates = values.length - fresh.length;
      if (dryRun) { report.imported = fresh.length; return report; }
      for (let i = 0; i < fresh.length; i += 500) {
        const inserted = await tx.insert(transactions).values(fresh.slice(i, i + 500)).onConflictDoNothing().returning({ id: transactions.id });
        report.imported += inserted.length;
      }
      report.duplicates += fresh.length - report.imported;
      return report;
    });
  }
}
