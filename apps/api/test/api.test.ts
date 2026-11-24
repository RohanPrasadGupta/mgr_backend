import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;

beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

describe("health", () => {
  it("reports ready with a working DB", async () => {
    expect((await c.get("/health")).status).toBe(200);
    expect((await c.get("/ready")).body.status).toBe("ready");
  });
});

describe("auth", () => {
  it("registers with default Cash account and categories, rejects duplicates", async () => {
    const { token, user } = await registerUser(c);
    expect(user.baseCurrency).toBe("THB");
    const accts = await c.get("/v1/accounts", token);
    expect(accts.body.data).toHaveLength(1);
    expect(accts.body.data[0]).toMatchObject({ name: "Cash", currency: "THB", balanceMinor: 0 });
    const cats = await c.get("/v1/categories", token);
    expect(cats.body.data.length).toBeGreaterThan(10);
    const dup = await c.post("/v1/auth/register", { email: "A@example.com", password: "password123", name: "x" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("email_taken");
  });
  it("validates input with a structured error", async () => {
    const r = await c.post("/v1/auth/register", { email: "nope", password: "short", name: "" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_error");
  });
  it("logs in, rejects bad passwords generically, and guards routes", async () => {
    await registerUser(c);
    expect((await c.post("/v1/auth/login", { email: "a@example.com", password: "wrong-password" })).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email: "ghost@example.com", password: "password123" })).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email: "a@example.com", password: "password123" })).status).toBe(200);
    expect((await c.get("/v1/accounts")).status).toBe(401);
    expect((await c.get("/v1/accounts", "garbage")).status).toBe(401);
  });
  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const { refresh } = await registerUser(c);
    const r1 = await c.post("/v1/auth/refresh", { refreshToken: refresh });
    expect(r1.status).toBe(200);
    const newRefresh = r1.body.data.refreshToken;
    expect((await c.post("/v1/auth/refresh", { refreshToken: refresh })).status).toBe(401); // reuse
    expect((await c.post("/v1/auth/refresh", { refreshToken: newRefresh })).status).toBe(401); // family killed
  });
  it("logout revokes the refresh token", async () => {
    const { refresh } = await registerUser(c);
    expect((await c.post("/v1/auth/logout", { refreshToken: refresh })).status).toBe(204);
    expect((await c.post("/v1/auth/refresh", { refreshToken: refresh })).status).toBe(401);
  });
});

describe("ledger", () => {
  it("creates transactions, computes balances, and buckets by user timezone", async () => {
    const { token } = await registerUser(c);
    const [acct] = (await c.get("/v1/accounts", token)).body.data;
    const cats = (await c.get("/v1/categories", token)).body.data;
    const food = cats.find((x: any) => x.name === "Food" && x.kind === "expense");
    const salary = cats.find((x: any) => x.name === "Salary");
    await c.post("/v1/transactions", { accountId: acct.id, kind: "income", amountMinor: 3_000_000, categoryId: salary.id, occurredAt: "2025-08-31T18:30:00Z" }, token);
    const t = await c.post("/v1/transactions", { accountId: acct.id, kind: "expense", amountMinor: 12_000, categoryId: food.id, note: "lunch", occurredAt: "2025-08-31T18:30:00Z" }, token);
    expect(t.status).toBe(201);
    expect(t.body.data.occurredOn).toBe("2025-09-01"); // 01:30 in Bangkok, so September
    expect(t.body.data.baseAmountMinor).toBe(12_000);
    expect((await c.get(`/v1/accounts/${acct.id}`, token)).body.data.balanceMinor).toBe(2_988_000);
  });
  it("rejects category kind mismatch and foreign accounts", async () => {
    const a = await registerUser(c, "a@example.com");
    const b = await registerUser(c, "b@example.com");
    const [acctA] = (await c.get("/v1/accounts", a.token)).body.data;
    const cats = (await c.get("/v1/categories", a.token)).body.data;
    const salary = cats.find((x: any) => x.name === "Salary");
    const mismatch = await c.post("/v1/transactions", { accountId: acctA.id, kind: "expense", amountMinor: 100, categoryId: salary.id }, a.token);
    expect(mismatch.body.error.code).toBe("category_kind_mismatch");
    const foreign = await c.post("/v1/transactions", { accountId: acctA.id, kind: "expense", amountMinor: 100 }, b.token);
    expect(foreign.status).toBe(422);
    expect((await c.get(`/v1/accounts/${acctA.id}`, b.token)).status).toBe(404);
  });
  it("is idempotent on clientId", async () => {
    const { token } = await registerUser(c);
    const [acct] = (await c.get("/v1/accounts", token)).body.data;
    const body = { accountId: acct.id, kind: "expense", amountMinor: 500, clientId: "0b6f6f0e-5b0a-4b5e-8a39-1d3a6f0c1111" };
    const one = await c.post("/v1/transactions", body, token);
    const two = await c.post("/v1/transactions", body, token);
    expect(two.body.data.id).toBe(one.body.data.id);
    expect((await c.get("/v1/transactions", token)).body.data).toHaveLength(1);
  });
  it("requires an fx rate for non-base accounts and stores base amounts", async () => {
    const { token } = await registerUser(c);
    const npr = (await c.post("/v1/accounts", { name: "NPR bank", type: "bank", currency: "NPR" }, token)).body.data;
    const missing = await c.post("/v1/transactions", { accountId: npr.id, kind: "expense", amountMinor: 39_000 }, token);
    expect(missing.body.error.code).toBe("fx_rate_required");
    const ok = await c.post("/v1/transactions", { accountId: npr.id, kind: "expense", amountMinor: 39_000, fxRate: 0.25 }, token);
    expect(ok.body.data.baseAmountMinor).toBe(9_750);
    expect(ok.body.data.currency).toBe("NPR");
  });
  it("handles same- and cross-currency transfers, which never count as income/expense", async () => {
    const { token } = await registerUser(c);
    const cash = (await c.get("/v1/accounts", token)).body.data[0];
    const bank = (await c.post("/v1/accounts", { name: "Bank", type: "bank", currency: "THB", openingBalanceMinor: 100_000 }, token)).body.data;
    await c.post("/v1/transfers", { fromAccountId: bank.id, toAccountId: cash.id, amountMinor: 40_000, occurredAt: "2025-08-10T05:00:00Z" }, token);
    expect((await c.get(`/v1/accounts/${bank.id}`, token)).body.data.balanceMinor).toBe(60_000);
    expect((await c.get(`/v1/accounts/${cash.id}`, token)).body.data.balanceMinor).toBe(40_000);
    const s = (await c.get("/v1/insights/summary?from=2025-08-01&to=2025-08-31", token)).body.data;
    expect(s).toMatchObject({ incomeMinor: 0, expenseMinor: 0, transactionCount: 0 });
    const npr = (await c.post("/v1/accounts", { name: "NPR", type: "bank", currency: "NPR" }, token)).body.data;
    const missing = await c.post("/v1/transfers", { fromAccountId: bank.id, toAccountId: npr.id, amountMinor: 1000, fxRate: 0.25 }, token);
    expect(missing.body.error.code).toBe("to_amount_required");
    expect((await c.post("/v1/transfers", { fromAccountId: bank.id, toAccountId: bank.id, amountMinor: 1 }, token)).status).toBe(422);
    // deleting one leg deletes the pair
    const list = (await c.get("/v1/transactions?kind=transfer_out", token)).body.data;
    expect((await c.del(`/v1/transactions/${list[0].id}`, token)).status).toBe(204);
    expect((await c.get(`/v1/accounts/${bank.id}`, token)).body.data.balanceMinor).toBe(100_000);
  });
  it("paginates with a stable cursor and filters", async () => {
    const { token } = await registerUser(c);
    const [acct] = (await c.get("/v1/accounts", token)).body.data;
    for (let i = 0; i < 5; i++) await c.post("/v1/transactions", { accountId: acct.id, kind: "expense", amountMinor: 100 + i, note: i === 3 ? "coffee beans" : "x", occurredAt: `2025-08-0${i + 1}T05:00:00Z` }, token);
    const p1 = (await c.get("/v1/transactions?limit=2", token)).body;
    expect(p1.data.map((t: any) => t.amountMinor)).toEqual([104, 103]);
    const p2 = (await c.get(`/v1/transactions?limit=2&cursor=${p1.meta.nextCursor}`, token)).body;
    expect(p2.data.map((t: any) => t.amountMinor)).toEqual([102, 101]);
    const p3 = (await c.get(`/v1/transactions?limit=2&cursor=${p2.meta.nextCursor}`, token)).body;
    expect(p3.data).toHaveLength(1);
    expect(p3.meta.nextCursor).toBeNull();
    expect((await c.get("/v1/transactions?q=COFFEE", token)).body.data).toHaveLength(1);
    expect((await c.get("/v1/transactions?from=2025-08-02&to=2025-08-03", token)).body.data).toHaveLength(2);
  });
  it("updates and soft-deletes transactions, and refuses to delete used accounts", async () => {
    const { token } = await registerUser(c);
    const [acct] = (await c.get("/v1/accounts", token)).body.data;
    const t = (await c.post("/v1/transactions", { accountId: acct.id, kind: "expense", amountMinor: 1000 }, token)).body.data;
    const up = await c.patch(`/v1/transactions/${t.id}`, { amountMinor: 2500, note: "fixed" }, token);
    expect(up.body.data).toMatchObject({ amountMinor: 2500, baseAmountMinor: 2500, note: "fixed", version: 2 });
    expect((await c.del(`/v1/accounts/${acct.id}`, token)).body.error.code).toBe("account_has_transactions");
    expect((await c.del(`/v1/transactions/${t.id}`, token)).status).toBe(204);
    expect((await c.get(`/v1/transactions/${t.id}`, token)).status).toBe(404);
    expect((await c.del(`/v1/accounts/${acct.id}`, token)).status).toBe(204);
  });
});

describe("insights", () => {
  it("summarises, groups by category and builds the 12-month trend", async () => {
    const { token } = await registerUser(c);
    const [acct] = (await c.get("/v1/accounts", token)).body.data;
    const cats = (await c.get("/v1/categories", token)).body.data;
    const id = (name: string, kind: string) => cats.find((x: any) => x.name === name && x.kind === kind).id;
    const add = (kind: string, amountMinor: number, name: string, at: string) => c.post("/v1/transactions", { accountId: acct.id, kind, amountMinor, categoryId: id(name, kind), occurredAt: at }, token);
    await add("income", 100_000, "Salary", "2025-08-05T05:00:00Z");
    await add("expense", 30_000, "Food", "2025-08-06T05:00:00Z");
    await add("expense", 10_000, "Transport", "2025-08-07T05:00:00Z");
    await add("expense", 20_000, "Food", "2025-09-02T05:00:00Z");
    const s = (await c.get("/v1/insights/summary?from=2025-08-01&to=2025-08-31", token)).body.data;
    expect(s).toMatchObject({ incomeMinor: 100_000, expenseMinor: 40_000, netMinor: 60_000, savingsRatePct: 60, savingsBand: "healthy", transactionCount: 3 });
    const bc = (await c.get("/v1/insights/by-category?from=2025-08-01&to=2025-09-30&kind=expense", token)).body.data;
    expect(bc.items.map((i: any) => [i.name, i.totalMinor])).toEqual([["Food", 50_000], ["Transport", 10_000]]);
    expect(bc.items[0].pct).toBeCloseTo(83.33, 1);
    const tr = (await c.get("/v1/insights/trend?year=2025", token)).body.data;
    expect(tr.incomeMinor[7]).toBe(100_000);
    expect(tr.expenseMinor[7]).toBe(40_000);
    expect(tr.expenseMinor[8]).toBe(20_000);
    expect(tr.cumulativeNetMinor[8]).toBe(40_000);
    expect((await c.get("/v1/insights/summary?from=bad&to=2025-01-01", token)).status).toBe(400);
  });
});

describe("profile + currencies", () => {
  it("lists currencies and updates profile with validation", async () => {
    const { token } = await registerUser(c);
    const cur = (await c.get("/v1/currencies", token)).body.data;
    expect(cur.find((x: any) => x.code === "NPR")).toBeTruthy();
    expect((await c.patch("/v1/me", { timezone: "Asia/Kathmandu", baseCurrency: "NPR" }, token)).body.data).toMatchObject({ timezone: "Asia/Kathmandu", baseCurrency: "NPR" });
    expect((await c.patch("/v1/me", { timezone: "Mars/Base" }, token)).status).toBe(400);
    expect((await c.patch("/v1/me", { baseCurrency: "ZZZ" }, token)).status).toBe(422);
  });
});
