/**
 * Pure investment math: position/cost-basis engine and XIRR.
 * Amounts are minor units (floats allowed internally for per-unit costs); callers round money at the edge.
 */
export type TradeType = "buy" | "sell" | "dividend" | "bonus" | "fee" | "contribution" | "withdrawal";
export type CostMethod = "wavg" | "fifo" | "manual";
export type Tracking = "units" | "value";

export interface EngineTrade {
  id: string;
  type: TradeType;
  quantity?: number | null;
  amountMinor: number; // gross, before fee
  feeMinor: number;
  tradedOn: string; // YYYY-MM-DD
  includeInAvg: boolean;
  seq: number; // creation order, tie-breaker
}
export interface Cashflow { date: string; amountMinor: number }
export interface Position {
  quantity: number;
  remainingCostMinor: number;
  /**
   * Displayed average cost per unit (minor units, fractional). Buys flagged includeInAvg = false are left out of it
   * (for every cost method) as long as at least one buy is flagged; `manual` always uses the flagged buys only.
   * P/L and the cost of the holding always count every buy.
   */
  avgCostMinor: number | null;
  totalBoughtMinor: number;
  totalSoldMinor: number;
  contributedMinor: number;
  withdrawnMinor: number;
  feesMinor: number;
  dividendsMinor: number;
  realisedPnlMinor: number;
  cashflows: Cashflow[]; // investor's view: money out negative, money in positive
  error?: { code: "insufficient_quantity" | "invalid_trade_for_asset"; tradeId: string };
}

const EPS = 1e-9;
const rank = (t: TradeType) => (t === "buy" || t === "bonus" || t === "contribution" ? 0 : 1);

export function sortTrades<T extends EngineTrade>(trades: T[]): T[] {
  return [...trades].sort((a, b) => a.tradedOn.localeCompare(b.tradedOn) || rank(a.type) - rank(b.type) || a.seq - b.seq);
}

export function computePosition(input: EngineTrade[], tracking: Tracking, method: CostMethod): Position {
  const p: Position = {
    quantity: 0, remainingCostMinor: 0, avgCostMinor: null, totalBoughtMinor: 0, totalSoldMinor: 0, contributedMinor: 0,
    withdrawnMinor: 0, feesMinor: 0, dividendsMinor: 0, realisedPnlMinor: 0, cashflows: [],
  };
  let cost = 0, qty = 0;
  const lots: { qty: number; unitCost: number }[] = [];
  let incCost = 0, incQty = 0, excluded = 0; // the "use for average" buys

  for (const t of sortTrades(input)) {
    const q = t.quantity ?? 0;
    const unitsOnly = t.type === "buy" || t.type === "sell" || t.type === "bonus";
    const valueOnly = t.type === "contribution" || t.type === "withdrawal";
    if ((tracking === "value" && unitsOnly) || (tracking === "units" && valueOnly)) {
      return { ...p, error: { code: "invalid_trade_for_asset", tradeId: t.id } };
    }
    p.feesMinor += t.type === "fee" ? t.amountMinor : t.feeMinor;
    switch (t.type) {
      case "buy": {
        const c = t.amountMinor + t.feeMinor;
        qty += q; cost += c; lots.push({ qty: q, unitCost: c / q });
        p.totalBoughtMinor += t.amountMinor;
        if (t.includeInAvg) { incCost += c; incQty += q; } else excluded++;
        p.cashflows.push({ date: t.tradedOn, amountMinor: -c });
        break;
      }
      case "bonus": // free shares: dilute average cost, no cash moves
        qty += q; lots.push({ qty: q, unitCost: 0 });
        break;
      case "sell": {
        if (q > qty + EPS) return { ...p, error: { code: "insufficient_quantity", tradeId: t.id } };
        let costOut: number;
        if (method === "fifo") {
          let need = q; costOut = 0;
          while (need > EPS && lots.length) {
            const lot = lots[0]!;
            const take = Math.min(lot.qty, need);
            costOut += take * lot.unitCost; lot.qty -= take; need -= take;
            if (lot.qty <= EPS) lots.shift();
          }
        } else {
          costOut = qty > EPS ? (cost / qty) * q : 0;
          let need = q; // keep lots roughly in sync for display only
          while (need > EPS && lots.length) { const lot = lots[0]!; const take = Math.min(lot.qty, need); lot.qty -= take; need -= take; if (lot.qty <= EPS) lots.shift(); }
        }
        const proceeds = t.amountMinor - t.feeMinor;
        p.realisedPnlMinor += proceeds - costOut;
        p.totalSoldMinor += t.amountMinor;
        qty -= q; cost -= costOut;
        p.cashflows.push({ date: t.tradedOn, amountMinor: proceeds });
        break;
      }
      case "dividend":
        p.dividendsMinor += t.amountMinor - t.feeMinor;
        p.cashflows.push({ date: t.tradedOn, amountMinor: t.amountMinor - t.feeMinor });
        break;
      case "fee":
        if (tracking === "units") p.realisedPnlMinor -= t.amountMinor;
        p.cashflows.push({ date: t.tradedOn, amountMinor: -t.amountMinor });
        break;
      case "contribution": {
        const c = t.amountMinor + t.feeMinor;
        p.contributedMinor += t.amountMinor; cost += c;
        qty += q; // amount-only assets may still note the units bought; when they do, the units held are kept too
        p.cashflows.push({ date: t.tradedOn, amountMinor: -c });
        break;
      }
      case "withdrawal":
        p.withdrawnMinor += t.amountMinor; cost -= t.amountMinor;
        qty -= q;
        p.cashflows.push({ date: t.tradedOn, amountMinor: t.amountMinor - t.feeMinor });
        break;
    }
  }
  if (Math.abs(qty) < EPS) qty = 0;
  p.quantity = qty;
  p.remainingCostMinor = qty === 0 && tracking === "units" ? 0 : cost;
  if (tracking === "units") {
    const methodAvg = qty > 0 ? cost / qty : null;
    if (method === "manual") p.avgCostMinor = incQty > 0 ? incCost / incQty : null;
    // some buys switched off (and some on): average the ones that are on; nothing switched on means "use them all"
    else p.avgCostMinor = excluded > 0 && incQty > 0 && qty > 0 ? incCost / incQty : methodAvg;
  }
  return p;
}

/** Annualised internal rate of return for dated cashflows (ACT/365). Null when it cannot be solved. */
export function xirr(flows: Cashflow[]): number | null {
  const fs = flows.filter((f) => f.amountMinor !== 0);
  if (!fs.some((f) => f.amountMinor < 0) || !fs.some((f) => f.amountMinor > 0)) return null;
  const t0 = Date.parse(fs.reduce((m, f) => (f.date < m ? f.date : m), fs[0]!.date));
  const yrs = fs.map((f) => (Date.parse(f.date) - t0) / 86_400_000 / 365);
  const npv = (r: number) => fs.reduce((s, f, i) => s + f.amountMinor / (1 + r) ** yrs[i]!, 0);
  let lo = -0.9999, hi = 1000;
  let fLo = npv(lo), fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (fLo * fm < 0) { hi = mid; fHi = fm; } else { lo = mid; fLo = fm; }
  }
  void fHi;
  return (lo + hi) / 2;
}
