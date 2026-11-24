import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

const mkAsset = async (token: string, body: object = {}) =>
  (await c.post("/v1/investments/assets", { symbol: "nabil", name: "Nabil Bank", class: "stock", currency: "THB", ...body }, token)).body.data;

describe("assets + trades", () => {
  it("creates assets with class-based tracking, rejects duplicates and bad currency", async () => {
    const { token } = await registerUser(c);
    const stock = await mkAsset(token);
    expect(stock).toMatchObject({ symbol: "NABIL", tracking: "units", costMethod: "wavg" });
    const sip = await mkAsset(token, { symbol: "NIC-SIP", class: "fund" });
    expect(sip.tracking).toBe("value");
    expect((await c.post("/v1/investments/assets", { symbol: "NABIL", name: "x", class: "stock", currency: "THB" }, token)).status).toBe(409);
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
    const f = await mkAsset(token, { symbol: "NIC SIP", class: "fund" });
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
    const n = await mkAsset(token, { symbol: "NEPSE1", currency: "NPR" });
    await c.post("/v1/investments/trades", { assetId: n.id, type: "buy", quantity: 1, priceMinor: 100, tradedOn: "2025-01-01" }, token);
    const p = (await c.get("/v1/investments/portfolio", token)).body.data;
    expect(p.excluded[0]).toMatchObject({ symbol: "NEPSE1" });
    expect(p.investedMinor).toBe(0);
    expect(p.holdings).toHaveLength(1); // still shown in its own currency
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
    { _id: { $oid: "a1" }, stockSymbol: "nabil", stockName: "Nabil Bank", type: "BUY", price: 1000, quantity: 10, totalAmount: 10_000, investedDate: { $date: "2025-01-10T00:00:00Z" }, currency: "NPR", useForAvgPrice: true },
    { _id: { $oid: "a2" }, stockSymbol: "NABIL", stockName: "Nabil Bank", type: "BUY", price: 1200, quantity: 10, totalAmount: 12_000, investedDate: "2025-02-10T00:00:00Z", currency: "NPR", useForAvgPrice: false },
    { _id: { $oid: "a3" }, stockSymbol: "NABIL", stockName: "Nabil Bank", type: "SELL", price: 1500, quantity: 5, totalAmount: 7_500, investedDate: "2025-03-10T00:00:00Z", currency: "NPR" },
    { stockSymbol: "BAD", type: "BUY", price: -1, quantity: 1, investedDate: "2025-03-10" },
  ];
  it("imports stock trades with the manual-average flag, dry-run first, idempotently", async () => {
    const { token } = await registerUser(c);
    const dry = (await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock, dryRun: true }, token)).body.data;
    expect(dry).toMatchObject({ imported: 3, invalid: [{ row: 4 }], createdAssets: ["stock:NABIL"], positionErrors: [] });
    expect((await c.get("/v1/investments/assets", token)).body.data).toHaveLength(0);
    const r = (await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock }, token)).body.data;
    expect(r).toMatchObject({ imported: 3, duplicates: 0 });
    expect((await c.post("/v1/imports/investments", { source: "stock-transactions", rows: stock }, token)).body.data).toMatchObject({ imported: 0, duplicates: 3 });
    const [h] = (await c.get("/v1/investments/assets", token)).body.data;
    expect(h.asset).toMatchObject({ symbol: "NABIL", currency: "NPR", costMethod: "manual" });
    expect(h).toMatchObject({ quantity: 15, avgCostMinor: 1000 * 100, tradeCount: 3 }); // only the flagged buy: 10 000 NPR / 10 units = 1 000 NPR = 100 000 paisa
    expect(h.realisedPnlMinor).toBe(750_000 - 550_000); // sell 7 500 vs running avg 1 100 × 5 (in paisa)
  });

  it("imports capital, coin, SIP and SSF documents into value assets", async () => {
    const { token } = await registerUser(c);
    const imp = async (source: string, rows: object[]) => (await c.post("/v1/imports/investments", { source, rows }, token)).body.data;
    expect(await imp("stock-capital", [{ date: "2025-01-01", amount: 50_000, type: "BUY", currency: "NPR" }, { date: "2025-02-01", amount: 10_000, type: "SELL", currency: "NPR" }])).toMatchObject({ imported: 2 });
    expect(await imp("coin-capital", [{ date: "2025-01-05", amount: 3_000, transactionCharge: 30, totalAmount: 3_030, type: "BUY", currency: "THB" }])).toMatchObject({ imported: 1 });
    expect(await imp("sip-capital", [{ name: "Nabil Equity", date: "2025-01-05", amount: 5_000, currency: "NPR" }, { name: "NIC Asia", date: "2025-01-05", amount: 2_000, currency: "NPR" }])).toMatchObject({ imported: 2 });
    expect(await imp("ssf-capital", [{ amount: 1_000, monthsPaid: 3, totalAmount: 3_000, dateAdded: "2025-01-01", paidDate: "2025-01-31", currency: "NPR", notes: "Q1" }])).toMatchObject({ imported: 1 });
    const hs = (await c.get("/v1/investments/assets", token)).body.data;
    const get = (sym: string) => hs.find((h: any) => h.asset.symbol === sym);
    expect(get("STOCK-CAPITAL")).toMatchObject({ contributedMinor: 5_000_000, withdrawnMinor: 1_000_000, remainingCostMinor: 4_000_000 });
    expect(get("COIN-CAPITAL")).toMatchObject({ contributedMinor: 300_000, feesMinor: 3_000, remainingCostMinor: 303_000 });
    expect(get("SSF")).toMatchObject({ contributedMinor: 300_000 });
    expect(hs.map((h: any) => h.asset.symbol).sort()).toEqual(["COIN-CAPITAL", "NABIL EQUITY", "NIC ASIA", "SSF", "STOCK-CAPITAL"]);
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
