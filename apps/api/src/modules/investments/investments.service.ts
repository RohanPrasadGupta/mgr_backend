import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  computePosition, convertMinor, defaultTracking, minorUnit, monthRange, toLocalDate, xirr,
  type Cashflow, type CreateAssetInput, type CreateTradeInput, type EngineTrade, type ListTradesInput, type Position,
  type SetPriceInput, type UpdateAssetInput, type UpdateTradeInput,
} from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { assetPrices, assets, currencies, trades, users } from "../../db/schema";
import { conflict, notFound, unprocessable } from "../../common/errors";
import { FxService } from "../fx/fx.service";
import { rememberCurrency } from "../users/user-currencies";

type Asset = typeof assets.$inferSelect;
type Trade = typeof trades.$inferSelect;
const r0 = Math.round;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const num = (v: string | null) => (v === null ? null : Number(v));

export const tradeView = (t: Trade) => ({ ...t, quantity: num(t.quantity), priceMinor: num(t.priceMinor) });
const toEngine = (rows: Trade[]): EngineTrade[] =>
  rows.map((t, i) => ({ id: t.id, type: t.type, quantity: num(t.quantity), amountMinor: t.amountMinor, feeMinor: t.feeMinor, tradedOn: t.tradedOn, includeInAvg: t.includeInAvg, seq: i }));

@Injectable()
export class InvestmentsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(FxService) private readonly fx: FxService) {}

  private async getUser(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return u;
  }

  // ---------- assets ----------
  async getAsset(userId: string, id: string): Promise<Asset> {
    const [a] = await this.db.select().from(assets).where(and(eq(assets.id, id), eq(assets.userId, userId), isNull(assets.deletedAt)));
    if (!a) throw notFound("Asset");
    return a;
  }

  async createAsset(userId: string, input: CreateAssetInput) {
    const [cur] = await this.db.select().from(currencies).where(eq(currencies.code, input.currency));
    if (!cur) throw unprocessable("unsupported_currency", `Currency ${input.currency} is not supported`);
    const [row] = await this.db
      .insert(assets)
      .values({ userId, symbol: input.symbol, name: input.name, class: input.class, currency: input.currency, tracking: input.tracking ?? defaultTracking(input.class), costMethod: input.costMethod })
      .returning();
    await rememberCurrency(this.db, userId, input.currency);
    return row!;
  }

  async updateAsset(userId: string, id: string, input: UpdateAssetInput) {
    const asset = await this.getAsset(userId, id);
    const { currency, ...rest } = input;
    if (currency && currency !== asset.currency) {
      const [cur] = await this.db.select().from(currencies).where(eq(currencies.code, currency));
      if (!cur) throw unprocessable("unsupported_currency", `Currency ${currency} is not supported`);
      // A relabel, not a conversion: the numbers stay what the user typed. Only the stored minor units follow the new
      // currency's decimals (e.g. THB 2 → JPY 0), so "10.50" stays 10.50 rather than becoming 1050.
      const shift = 10 ** (minorUnit(currency) - minorUnit(asset.currency));
      await this.db.transaction(async (tx) => {
        if (shift !== 1) {
          // a power of ten computed above (never user input), written as a numeric literal so Postgres knows its type
          const k = sql.raw(`${shift}::numeric`);
          await tx.update(trades).set({ amountMinor: sql`round(${trades.amountMinor} * ${k})`, feeMinor: sql`round(${trades.feeMinor} * ${k})`, priceMinor: sql`${trades.priceMinor} * ${k}` }).where(eq(trades.assetId, id));
          await tx.update(assetPrices).set({ priceMinor: sql`${assetPrices.priceMinor} * ${k}` }).where(eq(assetPrices.assetId, id));
        }
        await tx.update(assets).set({ ...rest, currency }).where(eq(assets.id, id));
        await rememberCurrency(tx, userId, currency);
      });
    } else if (Object.keys(rest).length) await this.db.update(assets).set(rest).where(eq(assets.id, id));
    return this.getAsset(userId, id);
  }

  async removeAsset(userId: string, id: string) {
    await this.getAsset(userId, id);
    const [t] = await this.db.select({ id: trades.id }).from(trades).where(and(eq(trades.assetId, id), isNull(trades.deletedAt))).limit(1);
    if (t) throw conflict("asset_has_trades", "Asset has trades; archive it instead");
    await this.db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, id));
  }

  // ---------- trades ----------
  private async assetTrades(userId: string, assetId: string) {
    return this.db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.assetId, assetId), isNull(trades.deletedAt))).orderBy(asc(trades.createdAt), asc(trades.id));
  }

  /** Fill in derived money fields and reject trades that make no sense for the asset. */
  private normalise(asset: Asset, t: { type: Trade["type"]; quantity?: number | null; priceMinor?: number | null; amountMinor?: number | null }) {
    const unitsOnly = t.type === "buy" || t.type === "sell" || t.type === "bonus";
    const valueOnly = t.type === "contribution" || t.type === "withdrawal";
    if ((asset.tracking === "value" && unitsOnly) || (asset.tracking === "units" && valueOnly)) {
      throw unprocessable("invalid_trade_for_asset", `${t.type} is not valid for a ${asset.tracking}-tracked asset (use ${asset.tracking === "units" ? "buy/sell" : "contribution/withdrawal"})`);
    }
    if (t.type === "bonus") return { quantity: t.quantity ?? null, priceMinor: null, amountMinor: 0 };
    if (t.type === "buy" || t.type === "sell") {
      const q = t.quantity!;
      const amount = t.amountMinor ?? r0(q * t.priceMinor!);
      return { quantity: q, priceMinor: t.priceMinor ?? amount / q, amountMinor: amount };
    }
    return { quantity: null, priceMinor: null, amountMinor: t.amountMinor! };
  }

  private assertPosition(asset: Asset, rows: Trade[]) {
    const p = computePosition(toEngine(rows), asset.tracking, asset.costMethod);
    if (p.error) throw unprocessable(p.error.code, p.error.code === "insufficient_quantity" ? "Not enough units held on that date to sell" : "Trade not valid for this asset", { tradeId: p.error.tradeId });
    return p;
  }

  async createTrade(userId: string, input: CreateTradeInput) {
    if (input.clientId) {
      const [dup] = await this.db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.clientId, input.clientId)));
      if (dup) return tradeView(dup);
    }
    const [asset, user] = await Promise.all([this.getAsset(userId, input.assetId), this.getUser(userId)]);
    if (asset.archived) throw unprocessable("asset_archived", "Asset is archived");
    const n = this.normalise(asset, input);
    const tradedOn = input.tradedOn ?? toLocalDate(new Date(), user.timezone);
    const existing = await this.assetTrades(userId, asset.id);
    const draft = { id: "00000000-0000-0000-0000-000000000000", userId, assetId: asset.id, type: input.type, quantity: n.quantity === null ? null : String(n.quantity), priceMinor: n.priceMinor === null ? null : String(n.priceMinor), amountMinor: n.amountMinor, feeMinor: input.feeMinor, tradedOn, note: input.note ?? null, includeInAvg: input.includeInAvg, clientId: input.clientId ?? null, createdAt: new Date(), deletedAt: null } satisfies Trade;
    this.assertPosition(asset, [...existing, draft]);
    const { id: _omit, ...values } = draft;
    const [row] = await this.db.insert(trades).values(values).returning();
    return tradeView(row!);
  }

  async updateTrade(userId: string, id: string, input: UpdateTradeInput) {
    const [cur] = await this.db.select().from(trades).where(and(eq(trades.id, id), eq(trades.userId, userId), isNull(trades.deletedAt)));
    if (!cur) throw notFound("Trade");
    const asset = await this.getAsset(userId, cur.assetId);
    const type = input.type ?? cur.type;
    const priced = type === "buy" || type === "sell";
    const merged = { type, quantity: input.quantity ?? num(cur.quantity), priceMinor: input.priceMinor ?? num(cur.priceMinor), amountMinor: input.amountMinor ?? cur.amountMinor };
    // changing quantity/price (or turning another kind into a buy/sell) without an explicit amount re-derives the amount
    const wasPriced = cur.type === "buy" || cur.type === "sell";
    if (priced && input.amountMinor === undefined && (input.quantity !== undefined || input.priceMinor !== undefined || !wasPriced)) merged.amountMinor = undefined as unknown as number;
    // a new type must come with what it needs (a buy/sell needs units and a price, a dividend an amount…)
    if ((priced || type === "bonus") && !(merged.quantity && merged.quantity > 0)) throw unprocessable("quantity_required", `A ${type} needs a quantity`);
    if (priced && !(merged.priceMinor && merged.priceMinor > 0) && merged.amountMinor === undefined) throw unprocessable("price_required", `A ${type} needs a price`);
    if (!priced && type !== "bonus" && !(merged.amountMinor && merged.amountMinor > 0)) throw unprocessable("amount_required", `A ${type} needs an amount`);
    const n = this.normalise(asset, merged);
    const patch = {
      type, quantity: n.quantity === null ? null : String(n.quantity), priceMinor: n.priceMinor === null ? null : String(n.priceMinor), amountMinor: n.amountMinor, feeMinor: input.feeMinor ?? cur.feeMinor, tradedOn: input.tradedOn ?? cur.tradedOn, note: input.note === undefined ? cur.note : input.note, includeInAvg: input.includeInAvg ?? cur.includeInAvg };
    const rows = (await this.assetTrades(userId, asset.id)).map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.assertPosition(asset, rows);
    const [row] = await this.db.update(trades).set(patch).where(eq(trades.id, id)).returning();
    return tradeView(row!);
  }

  async removeTrade(userId: string, id: string) {
    const [cur] = await this.db.select().from(trades).where(and(eq(trades.id, id), eq(trades.userId, userId), isNull(trades.deletedAt)));
    if (!cur) throw notFound("Trade");
    const asset = await this.getAsset(userId, cur.assetId);
    this.assertPosition(asset, (await this.assetTrades(userId, asset.id)).filter((t) => t.id !== id));
    await this.db.update(trades).set({ deletedAt: new Date() }).where(eq(trades.id, id));
  }

  async listTrades(userId: string, q: ListTradesInput) {
    const conds: (SQL | undefined)[] = [eq(trades.userId, userId), isNull(trades.deletedAt)];
    if (q.assetId) conds.push(eq(trades.assetId, q.assetId));
    if (q.type) conds.push(eq(trades.type, q.type));
    if (q.from) conds.push(gte(trades.tradedOn, q.from));
    if (q.to) conds.push(lte(trades.tradedOn, q.to));
    const rows = await this.db.select().from(trades).where(and(...conds)).orderBy(desc(trades.tradedOn), desc(trades.createdAt)).limit(q.limit);
    return rows.map(tradeView);
  }

  // ---------- prices ----------
  async setPrice(userId: string, assetId: string, input: SetPriceInput) {
    const [asset, user] = await Promise.all([this.getAsset(userId, assetId), this.getUser(userId)]);
    const asOn = input.asOn ?? toLocalDate(new Date(), user.timezone);
    await this.db.insert(assetPrices).values({ assetId: asset.id, asOn, priceMinor: String(input.priceMinor) }).onConflictDoUpdate({ target: [assetPrices.assetId, assetPrices.asOn], set: { priceMinor: String(input.priceMinor) } });
    return { assetId, asOn, priceMinor: input.priceMinor };
  }
  async listPrices(userId: string, assetId: string) {
    await this.getAsset(userId, assetId);
    const rows = await this.db.select().from(assetPrices).where(eq(assetPrices.assetId, assetId)).orderBy(desc(assetPrices.asOn)).limit(365);
    return rows.map((p) => ({ asOn: p.asOn, priceMinor: Number(p.priceMinor), source: p.source }));
  }

  // ---------- holdings ----------
  private buildHolding(asset: Asset, rows: Trade[], price: { asOn: string; priceMinor: number } | null, today: string) {
    const p: Position = computePosition(toEngine(rows), asset.tracking, asset.costMethod);
    const units = asset.tracking === "units";
    const marketValue = price ? (units ? p.quantity * price.priceMinor : price.priceMinor) : null;
    const unrealised = marketValue === null ? null : units && p.quantity === 0 ? 0 : marketValue - p.remainingCostMinor;
    const gain = units ? p.realisedPnlMinor + (unrealised ?? 0) + p.dividendsMinor : (unrealised ?? 0) + p.dividendsMinor;
    const basis = units ? p.totalBoughtMinor : p.contributedMinor + p.feesMinor;
    const flows: Cashflow[] = [...p.cashflows];
    if (marketValue && marketValue > 0) flows.push({ date: today, amountMinor: marketValue });
    const irr = marketValue === null && p.quantity !== 0 ? null : xirr(flows);
    const dates = rows.map((t) => t.tradedOn).sort();
    // rows arrive in creation order, so the last one per date is the latest entry of that day
    const latest = (type: "buy" | "sell") => {
      const of = rows.filter((t) => t.type === type && t.priceMinor !== null);
      const last = of.reduce<Trade | null>((best, t) => (!best || t.tradedOn >= best.tradedOn ? t : best), null);
      return last ? r4(Number(last.priceMinor)) : null;
    };
    return {
      asset,
      quantity: r4(p.quantity),
      avgCostMinor: p.avgCostMinor === null ? null : r4(p.avgCostMinor),
      remainingCostMinor: r0(p.remainingCostMinor),
      totalBoughtMinor: r0(p.totalBoughtMinor), totalSoldMinor: r0(p.totalSoldMinor),
      contributedMinor: r0(p.contributedMinor), withdrawnMinor: r0(p.withdrawnMinor),
      feesMinor: r0(p.feesMinor), dividendsMinor: r0(p.dividendsMinor), realisedPnlMinor: r0(p.realisedPnlMinor),
      latestPrice: price, marketValueMinor: marketValue === null ? null : r0(marketValue),
      unrealisedPnlMinor: unrealised === null ? null : r0(unrealised),
      returnPct: marketValue !== null && basis > 0 ? r4((gain / basis) * 100) : null,
      xirrPct: irr === null ? null : r4(irr * 100),
      closed: units && p.quantity === 0 && rows.length > 0,
      tradeCount: rows.length, firstTradedOn: dates[0] ?? null, lastTradedOn: dates[dates.length - 1] ?? null,
      lastBuyPriceMinor: latest("buy"), lastSellPriceMinor: latest("sell"),
      _position: p, _marketValue: marketValue,
    };
  }

  private async loadHoldings(userId: string, today: string, assetId?: string, includeArchived = false) {
    const list = await this.db.select().from(assets).where(and(eq(assets.userId, userId), isNull(assets.deletedAt), assetId ? eq(assets.id, assetId) : undefined, includeArchived ? undefined : eq(assets.archived, false))).orderBy(asc(assets.class), asc(assets.symbol));
    if (assetId && list.length === 0) throw notFound("Asset");
    const ids = list.map((a) => a.id);
    const allTrades = ids.length ? await this.db.select().from(trades).where(and(eq(trades.userId, userId), isNull(trades.deletedAt), inArray(trades.assetId, ids))).orderBy(asc(trades.createdAt), asc(trades.id)) : [];
    const prices = ids.length ? await this.db.selectDistinctOn([assetPrices.assetId], { assetId: assetPrices.assetId, asOn: assetPrices.asOn, priceMinor: assetPrices.priceMinor }).from(assetPrices).where(inArray(assetPrices.assetId, ids)).orderBy(assetPrices.assetId, desc(assetPrices.asOn)) : [];
    const priceBy = new Map(prices.map((p) => [p.assetId, { asOn: p.asOn, priceMinor: Number(p.priceMinor) }]));
    return list.map((a) => this.buildHolding(a, allTrades.filter((t) => t.assetId === a.id), priceBy.get(a.id) ?? null, today));
  }

  private strip<T extends { _position: unknown; _marketValue: unknown }>(h: T) {
    const { _position, _marketValue, ...rest } = h;
    return rest;
  }

  async listHoldings(userId: string, includeArchived = false) {
    const user = await this.getUser(userId);
    return (await this.loadHoldings(userId, toLocalDate(new Date(), user.timezone), undefined, includeArchived)).map((h) => this.strip(h));
  }
  async getHolding(userId: string, assetId: string) {
    const user = await this.getUser(userId);
    return this.strip((await this.loadHoldings(userId, toLocalDate(new Date(), user.timezone), assetId, true))[0]!);
  }

  /** Everything in the user's base currency at today's FX rates (assets with no available rate are listed in `excluded`). */
  async portfolio(userId: string) {
    const user = await this.getUser(userId);
    const today = toLocalDate(new Date(), user.timezone);
    const holdings = await this.loadHoldings(userId, today);
    const base = user.baseCurrency;
    const totals = { investedMinor: 0, marketValueMinor: 0, unrealisedPnlMinor: 0, realisedPnlMinor: 0, dividendsMinor: 0 };
    const byClass = new Map<string, number>();
    const flows: Cashflow[] = [];
    const excluded: { assetId: string; symbol: string; reason: string }[] = [];
    let unpriced = 0;
    for (const h of holdings) {
      const q = await this.fx.getRate(h.asset.currency, base, today);
      if (!q) { excluded.push({ assetId: h.asset.id, symbol: h.asset.symbol, reason: `no FX rate ${h.asset.currency}→${base}` }); continue; }
      const cv = (m: number) => convertMinor(r0(m), h.asset.currency, base, q.rate);
      const cost = cv(h._position.remainingCostMinor);
      const value = h._marketValue === null ? null : cv(h._marketValue);
      if (value === null && h._position.remainingCostMinor !== 0) unpriced++;
      totals.investedMinor += cost;
      totals.marketValueMinor += value ?? cost; // unpriced holdings are carried at cost
      if (value !== null) totals.unrealisedPnlMinor += h.unrealisedPnlMinor === null ? 0 : cv(h.unrealisedPnlMinor);
      totals.realisedPnlMinor += cv(h._position.realisedPnlMinor);
      totals.dividendsMinor += cv(h._position.dividendsMinor);
      byClass.set(h.asset.class, (byClass.get(h.asset.class) ?? 0) + (value ?? cost));
      for (const f of h._position.cashflows) flows.push({ date: f.date, amountMinor: cv(f.amountMinor) });
      const terminal = value ?? cost;
      if (terminal > 0) flows.push({ date: today, amountMinor: terminal });
    }
    const irr = xirr(flows);
    const total = totals.marketValueMinor;
    return {
      baseCurrency: base, asOf: today, ...totals,
      xirrPct: irr === null ? null : r4(irr * 100),
      /** Flows are converted at today's FX rate, and unpriced holdings are assumed flat — treat as approximate. */
      approximate: true,
      pricedAll: unpriced === 0,
      allocation: [...byClass].map(([cls, v]) => ({ class: cls, valueMinor: v, pct: total > 0 ? r4((v / total) * 100) : 0 })).sort((a, b) => b.valueMinor - a.valueMinor),
      holdings: holdings.map((h) => this.strip(h)),
      excluded,
    };
  }

  /**
   * Portfolio value at each month end, replayed from the user's own records (no market data): for every date, each asset's
   * position from the trades up to then, valued at the latest price/value entered on or before that date (carried at cost
   * when there is none yet — the same rule as `portfolio()`), converted at that date's stored FX rate. The last point is today,
   * so it matches the portfolio totals. Months before the first trade are left out.
   */
  async portfolioHistory(userId: string, months: number) {
    const user = await this.getUser(userId);
    const today = toLocalDate(new Date(), user.timezone);
    const base = user.baseCurrency;
    const list = await this.db.select().from(assets).where(and(eq(assets.userId, userId), isNull(assets.deletedAt), eq(assets.archived, false)));
    const ids = list.map((a) => a.id);
    const allTrades = ids.length ? await this.db.select().from(trades).where(and(eq(trades.userId, userId), isNull(trades.deletedAt), inArray(trades.assetId, ids))).orderBy(asc(trades.createdAt), asc(trades.id)) : [];
    const allPrices = ids.length ? await this.db.select({ assetId: assetPrices.assetId, asOn: assetPrices.asOn, priceMinor: assetPrices.priceMinor }).from(assetPrices).where(inArray(assetPrices.assetId, ids)).orderBy(asc(assetPrices.asOn)) : [];

    // month ends, oldest first; the current month ends today
    const [ty, tm] = today.split("-").map(Number) as [number, number];
    const dates: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const idx = ty * 12 + (tm - 1) - i;
      const y = Math.floor(idx / 12), m = (idx % 12) + 1;
      dates.push(i === 0 ? today : monthRange(y, m).to);
    }
    const firstTrade = allTrades.reduce<string | null>((min, t) => (min === null || t.tradedOn < min ? t.tradedOn : min), null);
    const visible = firstTrade === null ? [] : dates.filter((d) => d.slice(0, 7) >= firstTrade.slice(0, 7)); // from the first trade's month on

    const excluded: { assetId: string; symbol: string; reason: string }[] = [];
    const rateCache = new Map<string, number | null>();
    const rate = async (cur: string, date: string) => {
      const k = `${cur}|${date}`;
      if (!rateCache.has(k)) rateCache.set(k, (await this.fx.getRate(cur, base, date))?.rate ?? null);
      return rateCache.get(k)!;
    };
    const points: { date: string; valueMinor: number; investedMinor: number }[] = [];
    for (const date of visible) {
      let value = 0, invested = 0;
      for (const a of list) {
        const rows = allTrades.filter((t) => t.assetId === a.id && t.tradedOn <= date);
        if (rows.length === 0) continue;
        const p = computePosition(toEngine(rows), a.tracking, a.costMethod);
        let price: number | null = null;
        for (const pr of allPrices) if (pr.assetId === a.id && pr.asOn <= date) price = Number(pr.priceMinor);
        const mv = price === null ? null : a.tracking === "units" ? p.quantity * price : price;
        const fx = await rate(a.currency, date);
        if (fx === null) {
          if (!excluded.some((e) => e.assetId === a.id)) excluded.push({ assetId: a.id, symbol: a.symbol, reason: `no FX rate ${a.currency}→${base}` });
          continue;
        }
        const cost = convertMinor(r0(p.remainingCostMinor), a.currency, base, fx);
        invested += cost;
        value += mv === null ? cost : convertMinor(r0(mv), a.currency, base, fx);
      }
      points.push({ date, valueMinor: value, investedMinor: invested });
    }
    return { baseCurrency: base, asOf: today, points, approximate: true, excluded };
  }
}
