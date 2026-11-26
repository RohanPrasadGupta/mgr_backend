import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

const mkAsset = async (token: string, body: object = {}) =>
  (await c.post("/v1/investments/assets", { symbol: "acme", name: "Acme Corporation", class: "stock", currency: "THB", ...body }, token)).body.data;

describe("assets + trades", () => {
  it("crypto recorded by amount only: amount + fee per entry, units optional; tracking switchable only while empty", async () => {
    const { token } = await registerUser(c);
    const btc = await mkAsset(token, { symbol: "BTC", name: "Bitcoin", class: "crypto" }); // units by default
    expect((await c.patch(`/v1/investments/assets/${btc.id}`, { tracking: "value" }, token)).body.data.tracking).toBe("value");
    const add = (b: object) => c.post("/v1/investments/trades", { assetId: btc.id, ...b }, token);
    const withUnits = (await add({ type: "contribution", amountMinor: 80_000, feeMinor: 2_000, quantity: 0.004, tradedOn: "2024-12-02" })).body.data;
    expect(withUnits).toMatchObject({ quantity: 0.004, priceMinor: 20_000_000 }); // implied price per unit
    expect((await add({ type: "contribution", amountMinor: 50_000, feeMinor: 1_818, tradedOn: "2025-01-01" })).body.data).toMatchObject({ quantity: null, priceMinor: null });
    const h = (await c.get(`/v1/investments/assets/${btc.id}`, token)).body.data;
    expect(h).toMatchObject({ contributedMinor: 130_000, remainingCostMinor: 133_818, quantity: 0.004 });
    // clearing the units of an entry
    expect((await c.patch(`/v1/investments/trades/${withUnits.id}`, { quantity: null }, token)).body.data).toMatchObject({ quantity: null, amountMinor: 80_000 });
    // once something is recorded, the way it's recorded is fixed
    const locked = await c.patch(`/v1/investments/assets/${btc.id}`, { tracking: "units" }, token);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("asset_has_trades");
  });


  it("relabels an asset's currency (amounts kept; minor units follow the decimals) and adds it to the user's list", async () => {
    const { token } = await registerUser(c);
    const a = await mkAsset(token); // THB
    await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", quantity: 10, priceMinor: 43_300, tradedOn: "2025-01-01" }, token);
    const npr = (await c.patch(`/v1/investments/assets/${a.id}`, { currency: "NPR" }, token)).body.data;
    expect(npr.currency).toBe("NPR");
    expect((await c.get(`/v1/investments/assets/${a.id}`, token)).body.data).toMatchObject({ totalBoughtMinor: 433_000, avgCostMinor: 43_300 });
    expect((await c.get("/v1/me", token)).body.data.currencies).toContain("NPR");
    // to a 0-decimal currency: NPR 4,330.00 stays 4,330 (JPY), stored as 4330 minor units
    const jpy = await c.patch(`/v1/investments/assets/${a.id}`, { currency: "JPY" }, token);
    expect(jpy.body).toMatchObject({ data: { currency: "JPY" } });
    expect((await c.get(`/v1/investments/assets/${a.id}`, token)).body.data).toMatchObject({ totalBoughtMinor: 4_330, avgCostMinor: 433 });
    expect((await c.patch(`/v1/investments/assets/${a.id}`, { currency: "XXX" }, token)).body.error.code).toBe("unsupported_currency");
  });

  it("reports the latest buy and sell price, and respects 'use for average' on any cost method", async () => {
    const { token } = await registerUser(c);
    const a = await mkAsset(token);
    const add = (b: object) => c.post("/v1/investments/trades", { assetId: a.id, ...b }, token);
    await add({ type: "buy", quantity: 10, priceMinor: 100, tradedOn: "2025-01-01" });
    const second = (await add({ type: "buy", quantity: 10, priceMinor: 500, tradedOn: "2025-02-01" })).body.data;
    await add({ type: "sell", quantity: 5, priceMinor: 700, tradedOn: "2025-03-01" });
    let h = (await c.get(`/v1/investments/assets/${a.id}`, token)).body.data;
    expect(h).toMatchObject({ lastBuyPriceMinor: 500, lastSellPriceMinor: 700, avgCostMinor: 300 });
    await c.patch(`/v1/investments/trades/${second.id}`, { includeInAvg: false }, token);
    h = (await c.get(`/v1/investments/assets/${a.id}`, token)).body.data;
    expect(h.avgCostMinor).toBe(100); // the switched-off buy no longer counts toward the average
    expect(h.remainingCostMinor).toBe(4500); // …but still toward what the holding cost
  });


  it("changes an entry's type: buy ↔ sell keeps the units and price, and the new type must be valid", async () => {
    const { token } = await registerUser(c);
    const a = await mkAsset(token);
    await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", quantity: 10, priceMinor: 100, tradedOn: "2025-01-01" }, token);
    const wrong = (await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", quantity: 4, priceMinor: 150, tradedOn: "2025-02-01" }, token)).body.data;
    const sell = (await c.patch(`/v1/investments/trades/${wrong.id}`, { type: "sell" }, token)).body.data;
    expect(sell).toMatchObject({ type: "sell", quantity: 4, priceMinor: 150, amountMinor: 600 });
    expect((await c.get(`/v1/investments/assets/${a.id}`, token)).body.data.quantity).toBe(6);
    // and back, changing the price at the same time
    expect((await c.patch(`/v1/investments/trades/${wrong.id}`, { type: "buy", priceMinor: 120 }, token)).body.data).toMatchObject({ type: "buy", amountMinor: 480 });
    // a sell larger than the holding is still refused
    const big = (await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", quantity: 20, priceMinor: 100, tradedOn: "2025-03-01" }, token)).body.data;
    expect((await c.patch(`/v1/investments/trades/${big.id}`, { type: "sell" }, token)).body.error.code).toBe("insufficient_quantity");
    // a dividend needs an amount; switching to one keeps the old amount; units-only kinds can't go on a value-tracked asset
    expect((await c.patch(`/v1/investments/trades/${wrong.id}`, { type: "dividend" }, token)).body.data).toMatchObject({ type: "dividend", quantity: null, amountMinor: 480 });
    expect((await c.patch(`/v1/investments/trades/${wrong.id}`, { type: "buy" }, token)).body.error.code).toBe("quantity_required");
    expect((await c.patch(`/v1/investments/trades/${wrong.id}`, { type: "contribution" }, token)).body.error.code).toBe("invalid_trade_for_asset");
  });


  it("creates assets with class-based tracking, rejects duplicates and bad currency", async () => {
    const { token } = await registerUser(c);
    const stock = await mkAsset(token);
    expect(stock).toMatchObject({ symbol: "ACME", tracking: "units", costMethod: "wavg" });
    const sip = await mkAsset(token, { symbol: "GROWTH-SIP", class: "fund" });
    expect(sip.tracking).toBe("value");
    expect((await c.post("/v1/investments/assets", { symbol: "ACME", name: "x", class: "stock", currency: "THB" }, token)).status).toBe(409);
    expect((await c.post("/v1/investments/assets", { symbol: "X", name: "x", class: "stock", currency: "ZZZ" }, token)).status).toBe(422);
  });

  it("computes holdings: weighted avg, realised P/L, market value, unrealised and return", async () => {
    const { token } = await registerUser(c);
    const a = await mkAsset(token);
    const trade = (b: object) => c.post("/v1/investments/trades", { assetId: a.id, ...b }, token);
    expect((await trade({ type: "buy", quantity: 10, priceMinor: 100, tradedOn: "2025-01-01" })).body.data.amountMinor).toBe(1000);
    await trade({ type: "buy", quantity: 10, amountMinor: 2000, tradedOn: "2025-02-01" }); // price derived = 200
    await trade({ type: "sell", quantity: 5, priceMinor: 300, tradedOn: "2025-03-01" });
    await c.post(`/v1/investments/assets/${a.id}/prices`, { asOn: "2025-04-01", priceMinor: 250 }, token);
    const h = (await c.get(`/v1/investments/assets/${a.id}`, token)).body.data;
    expect(h).toMatchObject({ quantity: 15, avgCostMinor: 150, remainingCostMinor: 2250, totalBoughtMinor: 3000, totalSoldMinor: 1500, realisedPnlMinor: 750, marketValueMinor: 3750, unrealisedPnlMinor: 1500, tradeCount: 3 });
    expect(h.returnPct).toBeCloseTo(((750 + 1500) / 3000) * 100, 2); // 75%
    expect(h.latestPrice).toEqual({ asOn: "2025-04-01", priceMinor: 250 });
    expect(h.xirrPct).toBeGreaterThan(0);
    // a newer price wins; an older one doesn't
    await c.post(`/v1/investments/assets/${a.id}/prices`, { asOn: "2025-03-15", priceMinor: 999 }, token);
    expect((await c.get(`/v1/investments/assets/${a.id}`, token)).body.data.latestPrice.priceMinor).toBe(250);
    expect((await c.get(`/v1/investments/assets/${a.id}/prices`, token)).body.data).toHaveLength(2);
  });

  it("supports FIFO and the v1 'use for avg' manual method", async () => {
    const { token } = await registerUser(c);
    const fifo = await mkAsset(token, { symbol: "F", costMethod: "fifo" });
    const man = await mkAsset(token, { symbol: "M", costMethod: "manual" });
    for (const [id, flag] of [[fifo.id, true], [man.id, false]] as const) {
      await c.post("/v1/investments/trades", { assetId: id, type: "buy", quantity: 10, amountMinor: 1000, tradedOn: "2025-01-01", includeInAvg: flag }, token);
      await c.post("/v1/investments/trades", { assetId: id, type: "buy", quantity: 10, amountMinor: 2000, tradedOn: "2025-02-01" }, token);
      await c.post("/v1/investments/trades", { assetId: id, type: "sell", quantity: 5, amountMinor: 1500, tradedOn: "2025-03-01" }, token);
    }
    expect((await c.get(`/v1/investments/assets/${fifo.id}`, token)).body.data).toMatchObject({ realisedPnlMinor: 1000, remainingCostMinor: 2500 });
    expect((await c.get(`/v1/investments/assets/${man.id}`, token)).body.data).toMatchObject({ avgCostMinor: 200, realisedPnlMinor: 750 });
    expect((await c.patch(`/v1/investments/assets/${man.id}`, { costMethod: "wavg" }, token)).body.data.costMethod).toBe("wavg");
  });

  it("blocks overselling, wrong trade kinds, and deleting a buy that later sells depend on", async () => {
    const { token } = await registerUser(c);
    const a = await mkAsset(token);
    const sipFund = await mkAsset(token, { symbol: "SIP1", class: "fund" });
    const buy = (await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", quantity: 5, priceMinor: 100, tradedOn: "2025-01-01" }, token)).body.data;
    expect((await c.post("/v1/investments/trades", { assetId: a.id, type: "sell", quantity: 6, priceMinor: 100, tradedOn: "2025-01-02" }, token)).body.error.code).toBe("insufficient_quantity");
    await c.post("/v1/investments/trades", { assetId: a.id, type: "sell", quantity: 5, priceMinor: 100, tradedOn: "2025-01-02" }, token);
    expect((await c.del(`/v1/investments/trades/${buy.id}`, token)).body.error.code).toBe("insufficient_quantity");
    expect((await c.patch(`/v1/investments/trades/${buy.id}`, { quantity: 2 }, token)).status).toBe(422);
    expect((await c.post("/v1/investments/trades", { assetId: sipFund.id, type: "buy", quantity: 1, priceMinor: 1 }, token)).body.error.code).toBe("invalid_trade_for_asset");
    expect((await c.post("/v1/investments/trades", { assetId: a.id, type: "contribution", amountMinor: 5 }, token)).body.error.code).toBe("invalid_trade_for_asset");
    expect((await c.post("/v1/investments/trades", { assetId: a.id, type: "buy", priceMinor: 5 }, token)).status).toBe(400); // quantity required
    expect((await c.del(`/v1/investments/assets/${a.id}`, token)).body.error.code).toBe("asset_has_trades");
  });

  it("edits trades (amount re-derived), is idempotent on clientId, and scopes by user", async () => {
    const a1 = await registerUser(c, "a@example.com");
    const b1 = await registerUser(c, "b@example.com");
    const asset = await mkAsset(a1.token);
    const body = { assetId: asset.id, type: "buy", quantity: 4, priceMinor: 250, tradedOn: "2025-01-01", clientId: "6e1c2f5a-8f56-4a38-9c5b-0d6f0c8f9a11" };
    const one = (await c.post("/v1/investments/trades", body, a1.token)).body.data;
    expect((await c.post("/v1/investments/trades", body, a1.token)).body.data.id).toBe(one.id);
    const up = (await c.patch(`/v1/investments/trades/${one.id}`, { quantity: 8, note: "more" }, a1.token)).body.data;
    expect(up).toMatchObject({ quantity: 8, amountMinor: 2000, note: "more" });
    expect((await c.get("/v1/investments/trades", a1.token)).body.data).toHaveLength(1);
    expect((await c.get(`/v1/investments/assets/${asset.id}`, b1.token)).status).toBe(404);
    expect((await c.post("/v1/investments/trades", { ...body, clientId: undefined }, b1.token)).status).toBe(404);
    expect((await c.patch(`/v1/investments/trades/${one.id}`, { note: "x" }, b1.token)).status).toBe(404);
  });

  it("value assets (SIP/SSF): contributions, withdrawals, fees, current value and gain", async () => {
    const { token } = await registerUser(c);
    const f = await mkAsset(token, { symbol: "GROWTH SIP", class: "fund" });
    const add = (b: object) => c.post("/v1/investments/trades", { assetId: f.id, ...b }, token);
    await add({ type: "contribution", amountMinor: 100_000, feeMinor: 500, tradedOn: "2025-01-01" });
    await add({ type: "contribution", amountMinor: 100_000, tradedOn: "2025-02-01" });
    await add({ type: "withdrawal", amountMinor: 50_000, tradedOn: "2025-03-01" });
    await add({ type: "dividend", amountMinor: 1_000, tradedOn: "2025-03-02" });
    let h = (await c.get(`/v1/investments/assets/${f.id}`, token)).body.data;
    expect(h).toMatchObject({ contributedMinor: 200_000, withdrawnMinor: 50_000, remainingCostMinor: 150_500, feesMinor: 500, dividendsMinor: 1_000, marketValueMinor: null, unrealisedPnlMinor: null, returnPct: null });
    await c.post(`/v1/investments/assets/${f.id}/prices`, { asOn: "2025-04-01", priceMinor: 170_000 }, token); // total value
    h = (await c.get(`/v1/investments/assets/${f.id}`, token)).body.data;
    expect(h).toMatchObject({ marketValueMinor: 170_000, unrealisedPnlMinor: 19_500 });
    expect(h.returnPct).toBeCloseTo(((19_500 + 1_000) / 200_500) * 100, 2);
  });
});

describe("portfolio", () => {
  it("rolls holdings up in base currency, carries unpriced at cost, and reports allocation", async () => {
    const { token } = await registerUser(c);
    const s = await mkAsset(token, { symbol: "PTT" });
    const f = await mkAsset(token, { symbol: "FUND", class: "fund" });
    await c.post("/v1/investments/trades", { assetId: s.id, type: "buy", quantity: 10, priceMinor: 1000, tradedOn: "2025-01-01" }, token);
    await c.post("/v1/investments/trades", { assetId: f.id, type: "contribution", amountMinor: 5_000, tradedOn: "2025-01-01" }, token);
    await c.post(`/v1/investments/assets/${s.id}/prices`, { asOn: "2025-06-01", priceMinor: 1200 }, token);
    const p = (await c.get("/v1/investments/portfolio", token)).body.data;
    expect(p).toMatchObject({ baseCurrency: "THB", investedMinor: 15_000, marketValueMinor: 17_000, unrealisedPnlMinor: 2_000, pricedAll: false, approximate: true });
    expect(p.allocation.map((a: any) => [a.class, a.valueMinor])).toEqual([["stock", 12_000], ["fund", 5_000]]);
    expect(p.holdings).toHaveLength(2);
    expect(p.excluded).toEqual([]);
  });

  it("excludes assets in currencies with no FX rate instead of guessing", async () => {
    const { token } = await registerUser(c);
    const n = await mkAsset(token, { symbol: "LOCAL1", currency: "NPR" });
    await c.post("/v1/investments/trades", { assetId: n.id, type: "buy", quantity: 1, priceMinor: 100, tradedOn: "2025-01-01" }, token);
    const p = (await c.get("/v1/investments/portfolio", token)).body.data;
    expect(p.excluded[0]).toMatchObject({ symbol: "LOCAL1" });
    expect(p.investedMinor).toBe(0);
    expect(p.holdings).toHaveLength(1); // still shown in its own currency
  });
});

describe("portfolio history", () => {
  const ym = (back: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };

  it("replays trades and manual prices month by month, carrying unpriced holdings at cost", async () => {
    const { token } = await registerUser(c);
    const s = await mkAsset(token, { symbol: "ACME" });
    const f = await mkAsset(token, { symbol: "GROWTH-SIP", class: "fund" });
    await c.post("/v1/investments/trades", { assetId: s.id, type: "buy", quantity: 10, priceMinor: 1000, tradedOn: `${ym(2)}-05` }, token);
    await c.post("/v1/investments/trades", { assetId: f.id, type: "contribution", amountMinor: 5_000, tradedOn: `${ym(2)}-05` }, token);
    await c.post(`/v1/investments/assets/${s.id}/prices`, { asOn: `${ym(1)}-10`, priceMinor: 1200 }, token);
    await c.post("/v1/investments/trades", { assetId: s.id, type: "sell", quantity: 5, priceMinor: 1500, tradedOn: `${ym(0)}-01` }, token);

    const h = (await c.get("/v1/investments/portfolio/history?months=4", token)).body.data;
    expect(h.baseCurrency).toBe("THB");
    expect(h.points.map((p: any) => p.date.slice(0, 7))).toEqual([ym(2), ym(1), ym(0)]); // nothing before the first trade
    expect(h.points.map((p: any) => [p.valueMinor, p.investedMinor])).toEqual([
      [15_000, 15_000], // no price yet: stock and fund at cost
      [17_000, 15_000], // stock re-priced at 12.00
      [11_000, 10_000], // half sold: 5 × 12.00 + fund 50.00; remaining cost 50.00 + 50.00
    ]);
    expect(h.points.at(-1).date).toBe(h.asOf);
    const p = (await c.get("/v1/investments/portfolio", token)).body.data;
    expect([p.marketValueMinor, p.investedMinor]).toEqual([11_000, 10_000]); // the last point matches today's totals
  });

  it("is empty without trades, skips assets with no FX rate, and validates the range", async () => {
    const { token } = await registerUser(c);
    expect((await c.get("/v1/investments/portfolio/history", token)).body.data.points).toEqual([]);
    const n = await mkAsset(token, { symbol: "LOCAL1", currency: "NPR" });
    await c.post("/v1/investments/trades", { assetId: n.id, type: "buy", quantity: 1, priceMinor: 100, tradedOn: `${ym(0)}-01` }, token);
    const h = (await c.get("/v1/investments/portfolio/history?months=1", token)).body.data;
    expect(h.excluded[0]).toMatchObject({ symbol: "LOCAL1" });
    expect(h.points).toEqual([{ date: h.asOf, valueMinor: 0, investedMinor: 0 }]);
    expect((await c.get("/v1/investments/portfolio/history?months=500", token)).status).toBe(400);
  });
});

describe("calc", () => {
  it("projects a SIP with the v1 formula", async () => {
    const { token } = await registerUser(c);
    const r = (await c.post("/v1/calc/sip", { monthly: 1000, annualRatePct: 12, years: 1 }, token)).body.data;
    expect(r.totalInvested).toBe(12_000);
    expect(r.maturityValue).toBeCloseTo(12_809.33, 1);
    expect(r.yearlyBreakdown).toHaveLength(1);
  });
});

describe("v1 investment import", () => {
  const stock = [
    { _id: { $oid: "a1" }, stockSymbol: "acme", stockName: "Acme Corporation", type: "BUY", price: 1000, quantity: 10, totalAmount: 10_000, investedDate: { $date: "2025-01-10T00:00:00Z" }, currency: "NPR", useForAvgPrice: true },
    { _id: { $oid: "a2" }, stockSymbol: "ACME", stockName: "Acme Corporation", type: "BUY", price: 1200, quantity: 10, totalAmount: 12_000, investedDate: "2025-02-10T00:00:00Z", currency: "NPR", useForAvgPrice: false },
    { _id: { $oid: "a3" }, stockSymbol: "ACME", stockName: "Acme Corporation", type: "SELL", price: 1500, quantity: 5, totalAmount: 7_500, investedDate: "2025-03-10T00:00:00Z", currency: "NPR" },
    { stockSymbol: "BAD", type: "BUY", price: -1, quantity: 1, investedDate: "2025-03-10" },
  ];
  it("imports stock trades with the manual-average flag, dry-run first, idempotently", async () => {
    const { token } = await registerUser(c);
    const dry = (await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock, dryRun: true }, token)).body.data;
    expect(dry).toMatchObject({ imported: 3, invalid: [{ row: 4 }], createdAssets: ["stock:ACME"], positionErrors: [] });
    expect((await c.get("/v1/investments/assets", token)).body.data).toHaveLength(0);
    const r = (await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock }, token)).body.data;
    expect(r).toMatchObject({ imported: 3, duplicates: 0 });
    expect((await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock }, token)).body.data).toMatchObject({ imported: 0, duplicates: 3 });
    const [h] = (await c.get("/v1/investments/assets", token)).body.data;
    expect(h.asset).toMatchObject({ symbol: "ACME", currency: "NPR", costMethod: "manual" });
    expect(h).toMatchObject({ quantity: 15, avgCostMinor: 1000 * 100, tradeCount: 3 }); // only the flagged buy: 10 000 NPR / 10 units = 1 000 NPR = 100 000 paisa
    expect(h.realisedPnlMinor).toBe(750_000 - 550_000); // sell 7 500 vs running avg 1 100 × 5 (in paisa)
  });

  it("imports capital, coin, SIP and SSF documents into value assets", async () => {
    const { token } = await registerUser(c);
    const imp = async (source: string, rows: object[]) => (await c.post("/v1/imports/investments", { source, rows }, token)).body.data;
    expect(await imp("stock-capital", [{ date: "2025-01-01", amount: 50_000, type: "BUY", currency: "NPR" }, { date: "2025-02-01", amount: 10_000, type: "SELL", currency: "NPR" }])).toMatchObject({ imported: 2 });
    expect(await imp("coin-capital", [{ date: "2025-01-05", amount: 3_000, transactionCharge: 30, totalAmount: 3_030, type: "BUY", currency: "THB" }])).toMatchObject({ imported: 1 });
    expect(await imp("sip-capital", [{ name: "Example Equity Fund", date: "2025-01-05", amount: 5_000, currency: "NPR" }, { name: "Growth Fund", date: "2025-01-05", amount: 2_000, currency: "NPR" }])).toMatchObject({ imported: 2 });
    expect(await imp("ssf-capital", [{ amount: 1_000, monthsPaid: 3, totalAmount: 3_000, dateAdded: "2025-01-01", paidDate: "2025-01-31", currency: "NPR", notes: "Q1" }])).toMatchObject({ imported: 1 });
    const hs = (await c.get("/v1/investments/assets", token)).body.data;
    const get = (sym: string) => hs.find((h: any) => h.asset.symbol === sym);
    expect(get("STOCK-CAPITAL")).toMatchObject({ contributedMinor: 5_000_000, withdrawnMinor: 1_000_000, remainingCostMinor: 4_000_000 });
    expect(get("COIN-CAPITAL")).toMatchObject({ contributedMinor: 300_000, feesMinor: 3_000, remainingCostMinor: 303_000 });
    expect(get("SSF")).toMatchObject({ contributedMinor: 300_000 });
    expect(hs.map((h: any) => h.asset.symbol).sort()).toEqual(["COIN-CAPITAL", "EXAMPLE EQUITY FUND", "GROWTH FUND", "SSF", "STOCK-CAPITAL"]);
    const trades = (await c.get("/v1/investments/trades?assetId=" + get("SSF").asset.id, token)).body.data;
    expect(trades[0].note).toBe("3 month(s) × 1000 — Q1");
  });

  it("refuses an import that would oversell, and writes nothing", async () => {
    const { token } = await registerUser(c);
    const rows = [{ _id: "x1", stockSymbol: "ABC", type: "SELL", price: 1, quantity: 5, totalAmount: 5, investedDate: "2025-01-01", currency: "NPR" }];
    const r = await c.post("/v1/imports/investments", { source: "stock-transactions", rows }, token);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("import_invalid_positions");
    expect((await c.get("/v1/investments/assets", token)).body.data).toHaveLength(0);
  });
});
