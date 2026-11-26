import { describe, expect, it } from "vitest";
import { computePosition, xirr, type EngineTrade } from "./portfolio";

let n = 0;
const t = (type: EngineTrade["type"], day: string, quantity: number | null, amountMinor: number, o: Partial<EngineTrade> = {}): EngineTrade =>
  ({ id: `t${++n}`, type, tradedOn: day, quantity, amountMinor, feeMinor: 0, includeInAvg: true, seq: n, ...o });

describe("position engine (units)", () => {
  const trades = () => [t("buy", "2025-01-01", 10, 1000), t("buy", "2025-02-01", 10, 2000), t("sell", "2025-03-01", 5, 1500)];
  it("weighted average: realised P/L uses the running average", () => {
    const p = computePosition(trades(), "units", "wavg");
    expect(p).toMatchObject({ quantity: 15, remainingCostMinor: 2250, avgCostMinor: 150, realisedPnlMinor: 750, totalBoughtMinor: 3000, totalSoldMinor: 1500 });
  });
  it("FIFO consumes the oldest lot first", () => {
    const p = computePosition(trades(), "units", "fifo");
    expect(p).toMatchObject({ quantity: 15, remainingCostMinor: 2500, realisedPnlMinor: 1000 });
  });
  it("manual (v1 'use for avg'): displayed avg only counts flagged buys, accounting ignores the flag", () => {
    const ts = [t("buy", "2025-01-01", 10, 1000, { includeInAvg: false }), t("buy", "2025-02-01", 10, 2000), t("sell", "2025-03-01", 5, 1500)];
    const p = computePosition(ts, "units", "manual");
    expect(p.avgCostMinor).toBe(200); // only the second buy
    expect(p.realisedPnlMinor).toBe(750); // running wavg across all buys
    expect(computePosition([t("buy", "2025-01-01", 1, 100, { includeInAvg: false })], "units", "manual").avgCostMinor).toBeNull();
  });
  it("weighted average: a buy switched off 'use for average' is left out of the average, not out of P/L", () => {
    const ts = [t("buy", "2025-01-01", 10, 1000), t("buy", "2025-02-01", 10, 5000, { includeInAvg: false })];
    const p = computePosition(ts, "units", "wavg");
    expect(p.avgCostMinor).toBe(100); // only the first buy
    expect(p.remainingCostMinor).toBe(6000); // the holding still cost all of it
    // nothing switched on (old imports) → every buy counts, as before
    const none = [t("buy", "2025-01-01", 10, 1000, { includeInAvg: false }), t("buy", "2025-02-01", 10, 3000, { includeInAvg: false })];
    expect(computePosition(none, "units", "wavg").avgCostMinor).toBe(200);
  });
  it("amount-only assets keep the units held when entries note them", () => {
    const p = computePosition([t("contribution", "2025-01-01", 0.5, 80_000, { feeMinor: 2000 }), t("contribution", "2025-02-01", null, 50_000), t("withdrawal", "2025-03-01", 0.2, 40_000)], "value", "wavg");
    expect(p).toMatchObject({ quantity: 0.3, contributedMinor: 130_000, withdrawnMinor: 40_000, remainingCostMinor: 92_000 });
  });
  it("capitalises buy fees into cost and nets sell fees from proceeds", () => {
    const p = computePosition([t("buy", "2025-01-01", 10, 1000, { feeMinor: 10 }), t("sell", "2025-02-01", 10, 1200, { feeMinor: 20 })], "units", "wavg");
    expect(p).toMatchObject({ quantity: 0, remainingCostMinor: 0, realisedPnlMinor: 1180 - 1010, feesMinor: 30 });
  });
  it("bonus shares dilute the average cost for free", () => {
    const p = computePosition([t("buy", "2025-01-01", 10, 1000), t("bonus", "2025-02-01", 5, 0)], "units", "wavg");
    expect(p.quantity).toBe(15);
    expect(p.avgCostMinor).toBeCloseTo(66.6667, 3);
  });
  it("rejects overselling, including when a later buy is removed", () => {
    expect(computePosition([t("buy", "2025-01-01", 5, 500), t("sell", "2025-01-02", 6, 600)], "units", "wavg").error?.code).toBe("insufficient_quantity");
    const buy = t("buy", "2025-01-01", 5, 500), sell = t("sell", "2025-01-02", 5, 600);
    expect(computePosition([buy, sell], "units", "wavg").error).toBeUndefined();
    expect(computePosition([sell], "units", "wavg").error?.tradeId).toBe(sell.id);
  });
  it("same-day buy and sell is accepted regardless of entry order", () => {
    const sell = t("sell", "2025-01-01", 5, 600), buy = t("buy", "2025-01-01", 5, 500);
    expect(computePosition([sell, buy], "units", "wavg").error).toBeUndefined();
  });
  it("tracks dividends and standalone fees", () => {
    const p = computePosition([t("buy", "2025-01-01", 10, 1000), t("dividend", "2025-06-01", null, 50), t("fee", "2025-06-02", null, 5)], "units", "wavg");
    expect(p).toMatchObject({ dividendsMinor: 50, realisedPnlMinor: -5, feesMinor: 5 });
  });
  it("refuses value-style trades on unit assets and vice versa", () => {
    expect(computePosition([t("contribution", "2025-01-01", null, 100)], "units", "wavg").error?.code).toBe("invalid_trade_for_asset");
    expect(computePosition([t("buy", "2025-01-01", 1, 100)], "value", "wavg").error?.code).toBe("invalid_trade_for_asset");
  });
});

describe("position engine (value assets: SIP / SSF / capital)", () => {
  it("nets contributions, withdrawals and fees", () => {
    const p = computePosition([t("contribution", "2025-01-01", null, 10_000, { feeMinor: 300 }), t("contribution", "2025-02-01", null, 5_000), t("withdrawal", "2025-03-01", null, 2_000)], "value", "wavg");
    expect(p).toMatchObject({ contributedMinor: 15_000, withdrawnMinor: 2_000, remainingCostMinor: 13_300, feesMinor: 300, quantity: 0, avgCostMinor: null });
  });
});

describe("xirr", () => {
  it("solves a one-year 10% investment", () => {
    expect(xirr([{ date: "2024-01-01", amountMinor: -1000 }, { date: "2025-01-01", amountMinor: 1100 }])!).toBeCloseTo(1.1 ** (365 / 366) - 1, 4);
  });
  it("handles losses, multiple flows and unsolvable inputs", () => {
    expect(xirr([{ date: "2025-01-01", amountMinor: -1000 }, { date: "2026-01-01", amountMinor: 500 }])!).toBeCloseTo(-0.5, 3);
    expect(xirr([{ date: "2025-01-01", amountMinor: -100 }, { date: "2025-07-01", amountMinor: -100 }, { date: "2026-01-01", amountMinor: 230 }])!).toBeGreaterThan(0.1);
    expect(xirr([{ date: "2025-01-01", amountMinor: -100 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });
});
