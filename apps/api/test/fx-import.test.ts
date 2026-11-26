import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { FxService } from "../src/modules/fx/fx.service";
import { splitEmoji } from "../src/modules/imports/imports.service";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
let fx: FxService;

const provider = (unix: number, rates: Record<string, number>) =>
  (async () => new Response(JSON.stringify({ result: "success", time_last_update_unix: unix, rates }), { status: 200 })) as unknown as typeof fetch;

beforeAll(async () => { app = await makeApp(); c = client(app); fx = app.get(FxService); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); await app.get<Db>(DB).execute(sql`truncate table fx_rates`); });

describe("fx", () => {
  it("stores provider rates and derives cross rates, as-of date, and approximate fallback", async () => {
    await fx.refresh(provider(Date.parse("2025-08-20T00:00:00Z") / 1000, { USD: 1, THB: 32, NPR: 128, JPY: 150 }));
    await fx.refresh(provider(Date.parse("2025-08-25T00:00:00Z") / 1000, { USD: 1, THB: 33, NPR: 132, JPY: 150 }));
    const { token } = await registerUser(c);
    const q = (await c.get("/v1/fx?from=NPR&to=THB&date=2025-08-22", token)).body.data;
    expect(q.rate).toBeCloseTo(32 / 128, 8);
    expect(q).toMatchObject({ asOf: "2025-08-20", approximate: false });
    expect((await c.get("/v1/fx?from=USD&to=THB&date=2025-09-30", token)).body.data).toMatchObject({ rate: 33, asOf: "2025-08-25" });
    expect((await c.get("/v1/fx?from=USD&to=THB&date=2020-01-01", token)).body.data).toMatchObject({ rate: 32, approximate: true });
    expect((await c.get("/v1/fx?from=THB&to=THB", token)).body.data.rate).toBe(1);
    expect((await c.get("/v1/fx?from=THB&to=XXX", token)).status).toBe(404);
  });
  it("rejects a bad provider payload and stores nothing", async () => {
    await expect(fx.refresh((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fx.refresh((async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/);
  });
  it("transactions use the stored rate when none is supplied; an explicit rate still wins", async () => {
    await fx.refresh(provider(Date.parse("2025-08-25T00:00:00Z") / 1000, { USD: 1, THB: 32, NPR: 128 }));
    const { token } = await registerUser(c);
    const npr = (await c.post("/v1/accounts", { name: "NPR bank", type: "bank", currency: "NPR" }, token)).body.data;
    const auto = await c.post("/v1/transactions", { accountId: npr.id, kind: "expense", amountMinor: 12_800 }, token);
    expect(auto.status).toBe(201);
    expect(auto.body.data.fxRate).toBeCloseTo(0.25);
    expect(auto.body.data.baseAmountMinor).toBe(3_200);
    const manual = await c.post("/v1/transactions", { accountId: npr.id, kind: "expense", amountMinor: 10_000, fxRate: 0.3 }, token);
    expect(manual.body.data.baseAmountMinor).toBe(3_000);
  });
  it("cross-currency transfer uses stored rates per leg", async () => {
    await fx.refresh(provider(Date.parse("2025-08-25T00:00:00Z") / 1000, { USD: 1, THB: 32, NPR: 128, JPY: 160 }));
    const { token } = await registerUser(c);
    const cash = (await c.get("/v1/accounts", token)).body.data[0];
    const npr = (await c.post("/v1/accounts", { name: "NPR", type: "bank", currency: "NPR" }, token)).body.data;
    const r = await c.post("/v1/transfers", { fromAccountId: cash.id, toAccountId: npr.id, amountMinor: 10_000, toAmountMinor: 40_000 }, token);
    expect(r.status).toBe(201);
    const [out, inn] = r.body.data.legs;
    expect(out.baseAmountMinor).toBe(10_000);
    expect(inn.baseAmountMinor).toBe(10_000); // 400.00 NPR × 0.25 = 100.00 THB
  });
});

describe("splitEmoji", () => {
  it("separates leading emoji icons from names", () => {
    expect(splitEmoji("🍜 Food")).toEqual({ icon: "🍜", name: "Food" });
    expect(splitEmoji("🍖🍖 Lotus")).toEqual({ icon: "🍖🍖", name: "Lotus" });
    expect(splitEmoji("✂️ saloon")).toEqual({ icon: "✂️", name: "saloon" });
    expect(splitEmoji("Rent")).toEqual({ icon: null, name: "Rent" });
    expect(splitEmoji("🍜")).toEqual({ icon: null, name: "🍜" });
  });
});

describe("import", () => {
  const rows = [
    { date: "2025-08-26 09:30", account: "Cash", category: "🌐 work", note: "", currency: "THB", amount: 30, type: "Expense" },
    { date: "2025-08-25 12:00", account: "Cash", category: "🍜 Food", note: "pad thai", currency: "THB", amount: 40.5, type: "Expense" },
    { date: "2025-08-25 12:00", account: "Cash", category: "🍜 Food", note: "pad thai", currency: "THB", amount: 40.5, type: "Expense" }, // legit identical twin
    { date: "2025-08-24", account: "Online", category: "💰 Salary", note: "", currency: "THB", amount: 30000, type: "Income" },
    { date: "not a date", account: "Cash", category: "x", currency: "THB", amount: 1, type: "Expense" },
    { date: "2025-08-24", account: "Cash", category: "x", currency: "THB", amount: -5, type: "Expense" },
  ];

  it("dry run reports without writing", async () => {
    const { token } = await registerUser(c);
    const r = (await c.post("/v1/imports/transactions", { rows, dryRun: true }, token)).body.data;
    expect(r).toMatchObject({ dryRun: true, total: 6, imported: 4, duplicates: 0 });
    expect(r.invalid.map((i: any) => i.row)).toEqual([5, 6]);
    expect(r.createdAccounts).toEqual(["Online"]);
    expect((await c.get("/v1/transactions", token)).body.data).toHaveLength(0);
  });

  it("imports, builds accounts/categories with icons, converts amounts, and is idempotent", async () => {
    const { token } = await registerUser(c);
    const r1 = (await c.post("/v1/imports/transactions", { rows }, token)).body.data;
    expect(r1).toMatchObject({ imported: 4, duplicates: 0 });
    const r2 = (await c.post("/v1/imports/transactions", { rows }, token)).body.data;
    expect(r2).toMatchObject({ imported: 0, duplicates: 4 });

    const list = (await c.get("/v1/transactions", token)).body.data;
    expect(list).toHaveLength(4);
    expect(list.filter((t: any) => t.amountMinor === 4050)).toHaveLength(2); // twins both kept
    const accts = (await c.get("/v1/accounts", token)).body.data;
    expect(accts.map((a: any) => a.name).sort()).toEqual(["Cash", "Online"]);
    expect(accts.find((a: any) => a.name === "Online").balanceMinor).toBe(3_000_000);
    expect(accts.find((a: any) => a.name === "Cash").balanceMinor).toBe(-(3000 + 4050 * 2));
    const cats = (await c.get("/v1/categories", token)).body.data;
    expect(cats.find((x: any) => x.name === "work")).toMatchObject({ icon: "🌐", kind: "expense" });
    expect(cats.filter((x: any) => x.name === "Food" && x.kind === "expense")).toHaveLength(1); // reused default
    const s = (await c.get("/v1/insights/summary?from=2025-08-01&to=2025-08-31", token)).body.data;
    expect(s).toMatchObject({ incomeMinor: 3_000_000, expenseMinor: 11_100 });
  });

  it("splits an account name across currencies and converts via stored FX", async () => {
    await fx.refresh(provider(Date.parse("2025-08-25T00:00:00Z") / 1000, { USD: 1, THB: 32, NPR: 128 }));
    const { token } = await registerUser(c);
    const r = (await c.post("/v1/imports/transactions", {
      rows: [
        { date: "2025-08-25 10:00", account: "Cash", category: "Food", currency: "THB", amount: 100, type: "Expense" },
        { date: "2025-08-25 11:00", account: "Cash", category: "Food", currency: "NPR", amount: 400, type: "Expense" },
      ],
    }, token)).body.data;
    expect(r).toMatchObject({ imported: 2, createdAccounts: ["Cash (NPR)"] });
    const tx = (await c.get("/v1/transactions?accountId=" + (await c.get("/v1/accounts", token)).body.data.find((a: any) => a.name === "Cash (NPR)").id, token)).body.data[0];
    expect(tx.baseAmountMinor).toBe(10_000);
  });

  it("reports rows it cannot price instead of failing the whole import", async () => {
    const { token } = await registerUser(c);
    const r = (await c.post("/v1/imports/transactions", {
      rows: [
        { date: "2025-08-25", account: "Cash", currency: "THB", amount: 1, type: "Expense" },
        { date: "2025-08-25", account: "Wallet", currency: "NPR", amount: 1, type: "Expense" },
      ],
    }, token)).body.data;
    expect(r.imported).toBe(1);
    expect(r.invalid).toEqual([{ row: 2, reason: "no FX rate for NPR→THB" }]);
    expect((await c.post("/v1/imports/transactions", { rows: [] }, token)).status).toBe(400);
  });

  it("interprets naive timestamps in the user's timezone", async () => {
    const { token } = await registerUser(c); // Asia/Bangkok
    await c.post("/v1/imports/transactions", { rows: [{ date: "2025-08-31 23:30", account: "Cash", currency: "THB", amount: 5, type: "Expense" }] }, token);
    const t = (await c.get("/v1/transactions", token)).body.data[0];
    expect(t.occurredOn).toBe("2025-08-31");
    expect(t.occurredAt).toBe("2025-08-31T16:30:00.000Z");
  });
});

describe("categories import", () => {
  it("creates missing categories with their emoji icons, skips ones that exist, and the transaction import then reuses them", async () => {
    const { token } = await registerUser(c);
    const rows = [
      { name: "🍜 Food", type: "Expense" }, // every new user already has Food
      { name: "🌐 work", type: "Expense" },
      { name: "💰 Side job", type: "Income" },
      { name: "Gift", type: "Transfer" },
    ];
    const dry = (await c.post("/v1/imports/categories", { rows, dryRun: true }, token)).body.data;
    expect(dry).toMatchObject({ dryRun: true, total: 4, imported: 2, duplicates: 1, created: ["expense:work", "income:Side job"] });
    expect(dry.invalid.map((x: any) => x.row)).toEqual([4]);

    expect((await c.post("/v1/imports/categories", { rows }, token)).body.data).toMatchObject({ imported: 2, duplicates: 1 });
    const cats = (await c.get("/v1/categories", token)).body.data;
    expect(cats.find((x: any) => x.name === "work")).toMatchObject({ kind: "expense", icon: "🌐" });
    expect(cats.find((x: any) => x.name === "Side job")).toMatchObject({ kind: "income", icon: "💰" });
    expect(cats.find((x: any) => x.name === "Food" && x.kind === "expense").icon).toBe("🍜"); // the default category takes the old emoji
    expect((await c.post("/v1/imports/categories", { rows }, token)).body.data).toMatchObject({ imported: 0, duplicates: 3 });

    const tx = (await c.post("/v1/imports/transactions", { rows: [{ date: "2025-08-01 10:00:00", account: "Cash", category: "🌐 Work", note: "", currency: "THB", amount: 10, type: "Expense" }] }, token)).body.data;
    expect(tx.createdCategories).toEqual([]); // matched "work" despite the different case
  });
});
