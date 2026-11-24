import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { computePosition, type EngineTrade, type ImportInvestmentsInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { assets, trades, users } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";
import { stableUuid } from "../../common/ids";
import { mapV1Row, type MappedRow } from "./investment-mappers";

export interface InvestmentImportReport {
  source: string; dryRun: boolean; total: number; imported: number; duplicates: number;
  invalid: { row: number; reason: string }[];
  createdAssets: string[];
  positionErrors: { symbol: string; message: string }[];
}

@Injectable()
export class InvestmentImportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async importV1(userId: string, input: Pick<ImportInvestmentsInput, "source" | "rows" | "dryRun">): Promise<InvestmentImportReport> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    const report: InvestmentImportReport = { source: input.source, dryRun: input.dryRun, total: input.rows.length, imported: 0, duplicates: 0, invalid: [], createdAssets: [], positionErrors: [] };

    const mapped: (MappedRow & { idx: number; clientId: string })[] = [];
    const seen = new Map<string, number>();
    input.rows.forEach((raw, i) => {
      try {
        const m = mapV1Row(input.source, raw, user.timezone);
        const n = (seen.get(m.key) ?? 0) + 1; // identical documents without an _id still import once each
        seen.set(m.key, n);
        mapped.push({ ...m, idx: i + 1, clientId: stableUuid(`inv:${userId}:${input.source}:${m.key}:${n}`) });
      } catch (e) {
        report.invalid.push({ row: i + 1, reason: e instanceof Error ? e.message : "invalid row" });
      }
    });

    return this.db.transaction(async (tx) => {
      const existingAssets = await tx.select().from(assets).where(and(eq(assets.userId, userId), isNull(assets.deletedAt)));
      const assetKey = (cls: string, sym: string) => `${cls}|${sym}`;
      const byKey = new Map(existingAssets.map((a) => [assetKey(a.class, a.symbol), a]));
      const resolved = new Map<string, { id: string; tracking: "units" | "value"; costMethod: "wavg" | "fifo" | "manual"; currency: string }>();
      const bad = new Set<number>();

      for (const m of mapped) {
        const k = assetKey(m.asset.class, m.asset.symbol);
        let a = resolved.get(k);
        if (!a) {
          const hit = byKey.get(k);
          if (hit) a = { id: hit.id, tracking: hit.tracking, costMethod: hit.costMethod, currency: hit.currency };
          else {
            const manual = mapped.some((x) => assetKey(x.asset.class, x.asset.symbol) === k && x.prefersManualCost);
            const costMethod = manual ? "manual" : "wavg";
            report.createdAssets.push(`${m.asset.class}:${m.asset.symbol}`);
            if (input.dryRun) a = { id: `dry:${k}`, tracking: m.asset.tracking, costMethod, currency: m.asset.currency };
            else {
              const [row] = await tx.insert(assets).values({ userId, symbol: m.asset.symbol, name: m.asset.name, class: m.asset.class, currency: m.asset.currency, tracking: m.asset.tracking, costMethod }).returning();
              a = { id: row!.id, tracking: row!.tracking, costMethod: row!.costMethod, currency: row!.currency };
            }
          }
          resolved.set(k, a);
        }
        if (a.currency !== m.asset.currency) { report.invalid.push({ row: m.idx, reason: `currency ${m.asset.currency} does not match asset currency ${a.currency}` }); bad.add(m.idx); }
      }
      const good = mapped.filter((m) => !bad.has(m.idx));

      const ids = good.map((m) => m.clientId);
      const dup = new Set<string>();
      for (let i = 0; i < ids.length; i += 1000) {
        (await tx.select({ c: trades.clientId }).from(trades).where(and(eq(trades.userId, userId), inArray(trades.clientId, ids.slice(i, i + 1000))))).forEach((r) => r.c && dup.add(r.c));
      }
      const fresh = good.filter((m) => !dup.has(m.clientId));
      report.duplicates = good.length - fresh.length;

      // position check per asset: existing trades + new ones must never oversell
      const realIds = [...resolved.values()].filter((a) => !a.id.startsWith("dry:")).map((a) => a.id);
      const stored = realIds.length ? await tx.select().from(trades).where(and(eq(trades.userId, userId), isNull(trades.deletedAt), inArray(trades.assetId, realIds))).orderBy(asc(trades.createdAt), asc(trades.id)) : [];
      for (const [k, a] of resolved) {
        const eng: EngineTrade[] = stored.filter((t) => t.assetId === a.id).map((t, i) => ({ id: t.id, type: t.type, quantity: t.quantity === null ? null : Number(t.quantity), amountMinor: t.amountMinor, feeMinor: t.feeMinor, tradedOn: t.tradedOn, includeInAvg: t.includeInAvg, seq: i }));
        fresh.filter((m) => assetKey(m.asset.class, m.asset.symbol) === k).forEach((m, i) => eng.push({ id: `row:${m.idx}`, type: m.trade.type, quantity: m.trade.quantity, amountMinor: m.trade.amountMinor, feeMinor: m.trade.feeMinor, tradedOn: m.trade.tradedOn, includeInAvg: m.trade.includeInAvg, seq: eng.length + i }));
        const p = computePosition(eng, a.tracking, a.costMethod);
        if (p.error) report.positionErrors.push({ symbol: k.split("|")[1]!, message: `${p.error.code} at ${p.error.tradeId}` });
      }
      if (input.dryRun) { report.imported = fresh.length; return report; }
      if (report.positionErrors.length) throw unprocessable("import_invalid_positions", "Import would oversell holdings; nothing was imported", report.positionErrors);

      const values = fresh.map((m) => ({
        userId, assetId: resolved.get(assetKey(m.asset.class, m.asset.symbol))!.id, type: m.trade.type,
        quantity: m.trade.quantity === null ? null : String(m.trade.quantity), priceMinor: m.trade.priceMinor === null ? null : String(m.trade.priceMinor),
        amountMinor: m.trade.amountMinor, feeMinor: m.trade.feeMinor, tradedOn: m.trade.tradedOn, note: m.trade.note, includeInAvg: m.trade.includeInAvg, clientId: m.clientId,
      }));
      for (let i = 0; i < values.length; i += 500) {
        report.imported += (await tx.insert(trades).values(values.slice(i, i + 500)).onConflictDoNothing().returning({ id: trades.id })).length;
      }
      report.duplicates += fresh.length - report.imported;
      return report;
    });
  }
}
