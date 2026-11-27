import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { FxService } from "../src/modules/fx/fx.service";
import { RecurringService } from "../src/modules/recurring/recurring.service";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;

beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); await app.get<Db>(DB).execute(sql`truncate table fx_rates`); });

async function setup() {
  const u = await registerUser(c);
  const acct = (await c.get("/v1/accounts", u.token)).body.data[0];
  const cats = (await c.get("/v1/categories", u.token)).body.data;
  const cat = (name: string, kind = "expense") => cats.find((x: any) => x.name === name && x.kind === kind);
  const spend = (amountMinor: number, categoryId: string | undefined, at: string) =>
    c.post("/v1/transactions", { accountId: acct.id, kind: "expense", amountMinor, categoryId, occurredAt: at }, u.token);
  return { ...u, acct, cat, spend };
}

describe("budgets", () => {
  it("tracks category spend incl. sub-categories, with ok/warning/over states", async () => {
    const { token, cat, spend } = await setup();
    const food = cat("Food");
    const sub = (await c.post("/v1/categories", { name: "Coffee", kind: "expense", parentId: food.id }, token)).body.data;
    const b = await c.post("/v1/budgets", { categoryId: food.id, period: "month", amountMinor: 100_000, startOn: "2025-08-01" }, token);
    expect(b.status).toBe(201);
    expect(b.body.data.currency).toBe("THB");

    const status = async () => (await c.get("/v1/budgets/status?date=2025-08-15", token)).body.data.items[0];
    await spend(50_000, food.id, "2025-08-03T05:00:00Z");
    expect(await status()).toMatchObject({ spentMinor: 50_000, remainingMinor: 50_000, pct: 50, state: "ok", window: { from: "2025-08-01", to: "2025-08-31" }, categoryName: "Food" });
    await spend(35_000, sub.id, "2025-08-04T05:00:00Z"); // sub-category counts toward the parent
    expect(await status()).toMatchObject({ spentMinor: 85_000, state: "warning" });
    await spend(20_000, food.id, "2025-08-05T05:00:00Z");
    expect(await status()).toMatchObject({ spentMinor: 105_000, remainingMinor: -5_000, state: "over" });
    await spend(999_999, food.id, "2025-09-05T05:00:00Z"); // other month ignored
    expect((await status()).spentMinor).toBe(105_000);
    expect((await c.get("/v1/budgets/status?date=2025-09-15", token)).body.data.items[0].spentMinor).toBe(999_999);
    expect((await c.get("/v1/budgets/status?date=2025-07-15", token)).body.data.items).toHaveLength(0); // before start
  });

  it("supports overall, weekly and custom budgets and ignores income/transfers", async () => {
    const { token, cat, spend, acct } = await setup();
    await c.post("/v1/budgets", { period: "month", amountMinor: 200_000, startOn: "2025-08-01" }, token); // overall
    await c.post("/v1/budgets", { period: "week", amountMinor: 10_000, startOn: "2025-08-01", categoryId: cat("Transport").id }, token);
    await c.post("/v1/budgets", { period: "custom", amountMinor: 5_000, startOn: "2025-08-10", endOn: "2025-08-12" }, token);
    await spend(1_000, cat("Transport").id, "2025-08-27T05:00:00Z"); // Wed, week 25-31
    await spend(2_000, cat("Food").id, "2025-08-11T05:00:00Z");
    await c.post("/v1/transactions", { accountId: acct.id, kind: "income", amountMinor: 900_000, occurredAt: "2025-08-12T05:00:00Z" }, token);
    const items = (await c.get("/v1/budgets/status?date=2025-08-27", token)).body.data.items;
    const by = (p: string, cid?: boolean) => items.find((i: any) => i.period === p);
    expect(by("month")).toMatchObject({ spentMinor: 3_000, categoryId: null });
    expect(by("week")).toMatchObject({ spentMinor: 1_000, window: { from: "2025-08-25", to: "2025-08-31" } });
    expect(by("custom")).toBeUndefined(); // 27th is outside 10–12
    const onTen = (await c.get("/v1/budgets/status?date=2025-08-11", token)).body.data.items.find((i: any) => i.period === "custom");
    expect(onTen).toMatchObject({ spentMinor: 2_000, window: { from: "2025-08-10", to: "2025-08-12" } });
  });

  it("validates, prevents duplicates, updates and deletes (per user)", async () => {
    const { token, cat } = await setup();
    const other = await registerUser(c, "other@example.com");
    expect((await c.post("/v1/budgets", { period: "custom", amountMinor: 1 }, token)).status).toBe(400);
    expect((await c.post("/v1/budgets", { period: "month", amountMinor: 1, categoryId: cat("Salary", "income").id }, token)).body.error.code).toBe("category_kind_mismatch");
    const ok = await c.post("/v1/budgets", { period: "month", amountMinor: 5_000, categoryId: cat("Food").id, startOn: "2025-01-01" }, token);
    expect((await c.post("/v1/budgets", { period: "month", amountMinor: 9_000, categoryId: cat("Food").id, startOn: "2025-02-01" }, token)).body.error.code).toBe("budget_exists");
    const id = ok.body.data.id;
    expect((await c.patch(`/v1/budgets/${id}`, { amountMinor: 7_000, alertThresholdPct: 90 }, token)).body.data).toMatchObject({ amountMinor: 7_000, alertThresholdPct: 90 });
    expect((await c.patch(`/v1/budgets/${id}`, { amountMinor: 1 }, other.token)).status).toBe(404);
    expect((await c.del(`/v1/budgets/${id}`, other.token)).status).toBe(404);
    expect((await c.del(`/v1/budgets/${id}`, token)).status).toBe(204);
    expect((await c.get("/v1/budgets", token)).body.data).toHaveLength(0);
  });

  it("repeats every month until switched off; switching it back on can't overlap another budget", async () => {
    const { token, cat } = await setup();
    const b = (await c.post("/v1/budgets", { period: "month", amountMinor: 5_000, categoryId: cat("Food").id, startOn: "2025-01-01" }, token)).body.data;
    expect(b.endOn).toBeNull();
    const on = async (date: string) => (await c.get(`/v1/budgets/status?date=${date}`, token)).body.data.items.length;
    expect(await on("2027-06-15")).toBe(1); // no end: still running years later
    await c.patch(`/v1/budgets/${b.id}`, { endOn: "2025-03-31" }, token);
    expect([await on("2025-03-15"), await on("2025-04-15")]).toEqual([1, 0]);
    expect((await c.patch(`/v1/budgets/${b.id}`, { endOn: "2024-12-31" }, token)).body.error.code).toBe("invalid_end_date");
    const next = (await c.post("/v1/budgets", { period: "month", amountMinor: 9_000, categoryId: cat("Food").id, startOn: "2025-05-01" }, token)).body.data;
    expect((await c.patch(`/v1/budgets/${b.id}`, { endOn: null }, token)).body.error.code).toBe("budget_exists");
    await c.del(`/v1/budgets/${next.id}`, token);
    expect((await c.patch(`/v1/budgets/${b.id}`, { endOn: null }, token)).body.data.endOn).toBeNull();
  });
});

describe("recurring", () => {
  const at = (iso: string) => new Date(iso);

  it("posts due occurrences once, links them to the rule, and is idempotent", async () => {
    const { token, acct, cat } = await setup();
    const rule = (await c.post("/v1/recurring", { accountId: acct.id, kind: "expense", amountMinor: 500_000, categoryId: cat("Rent").id, note: "rent", frequency: "monthly", startOn: "2025-01-05", backfill: true }, token)).body.data;
    expect(rule.nextDates).toEqual(["2025-01-05", "2025-02-05", "2025-03-05"]);
    const svc = app.get(RecurringService);
    const r1 = await svc.runDue({ now: at("2025-03-10T00:00:00Z") });
    expect(r1).toMatchObject({ rules: 1, posted: 3, errors: [] });
    expect((await svc.runDue({ now: at("2025-03-10T00:00:00Z") })).posted).toBe(0);
    const txs = (await c.get("/v1/transactions", token)).body.data;
    expect(txs).toHaveLength(3);
    expect(txs.every((t: any) => t.recurringId === rule.id && t.amountMinor === 500_000 && t.note === "rent")).toBe(true);
    expect(txs.map((t: any) => t.occurredOn).sort()).toEqual(["2025-01-05", "2025-02-05", "2025-03-05"]);
    const after = (await c.get(`/v1/recurring/${rule.id}`, token)).body.data;
    expect(after).toMatchObject({ nextRunOn: "2025-04-05", lastRunOn: "2025-03-05", lastError: null });
    expect((await svc.runDue({ now: at("2025-04-05T10:00:00Z") })).posted).toBe(1);
  });

  it("clamps month-end rules, honours endOn, and deactivates when finished", async () => {
    const { token, acct } = await setup();
    const rule = (await c.post("/v1/recurring", { accountId: acct.id, kind: "income", amountMinor: 1_000, frequency: "monthly", startOn: "2025-01-31", endOn: "2025-03-31", backfill: true }, token)).body.data;
    await app.get(RecurringService).runDue({ now: at("2025-06-01T00:00:00Z") });
    const dates = (await c.get("/v1/transactions", token)).body.data.map((t: any) => t.occurredOn).sort();
    expect(dates).toEqual(["2025-01-31", "2025-02-28", "2025-03-31"]);
    expect((await c.get(`/v1/recurring/${rule.id}`, token)).body.data.active).toBe(false);
  });

  it("without backfill, starts from the next upcoming occurrence", async () => {
    const { token, acct } = await setup();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    const rule = (await c.post("/v1/recurring", { accountId: acct.id, kind: "expense", amountMinor: 100, frequency: "daily", startOn: "2020-01-01" }, token)).body.data;
    expect(rule.nextRunOn).toBe(today); // daily rule from 2020 starts today, not 2020
    expect((await c.post("/v1/recurring", { accountId: acct.id, kind: "expense", amountMinor: 100, frequency: "daily", startOn: "2020-01-01", endOn: "2020-02-01" }, token)).body.error.code).toBe("nothing_to_schedule");
  });

  it("uses each owner's timezone for 'today', and records errors instead of crashing", async () => {
    const { token } = await setup(); // Asia/Bangkok
    const npr = (await c.post("/v1/accounts", { name: "NPR", type: "bank", currency: "NPR" }, token)).body.data;
    const rule = (await c.post("/v1/recurring", { accountId: npr.id, kind: "expense", amountMinor: 1_000, frequency: "weekly", startOn: "2025-08-01", backfill: true }, token)).body.data;
    const svc = app.get(RecurringService);
    const rep = await svc.runDue({ now: at("2025-08-01T10:00:00Z") });
    expect(rep.posted).toBe(0);
    expect(rep.errors[0]).toMatchObject({ ruleId: rule.id });
    expect((await c.get(`/v1/recurring/${rule.id}`, token)).body.data).toMatchObject({ nextRunOn: "2025-08-01", lastError: expect.stringContaining("fx") });
    // once a rate exists the same rule recovers on the next run
    await app.get(FxService).refresh((async () => new Response(JSON.stringify({ result: "success", time_last_update_unix: Date.parse("2025-08-01T00:00:00Z") / 1000, rates: { USD: 1, THB: 32, NPR: 128 } }))) as unknown as typeof fetch);
    expect((await svc.runDue({ now: at("2025-08-01T10:00:00Z") })).posted).toBe(1);
    expect((await c.get(`/v1/recurring/${rule.id}`, token)).body.data.lastError).toBeNull();
    // not yet due in Bangkok: 2025-08-07T20:00Z is already Aug 8 locally -> next weekly (Aug 8) is due
    expect((await svc.runDue({ now: at("2025-08-07T20:00:00Z") })).posted).toBe(1);
  });

  it("refuses to delete an account that still has an active recurring rule", async () => {
    const { token } = await setup();
    const bank = (await c.post("/v1/accounts", { name: "Bank", type: "bank", currency: "THB" }, token)).body.data;
    const rule = (await c.post("/v1/recurring", { accountId: bank.id, kind: "expense", amountMinor: 1, frequency: "monthly", startOn: "2030-01-01" }, token)).body.data;
    expect((await c.del(`/v1/accounts/${bank.id}`, token)).body.error.code).toBe("account_has_recurring");
    await c.del(`/v1/recurring/${rule.id}`, token);
    expect((await c.del(`/v1/accounts/${bank.id}`, token)).status).toBe(204);
  });

  it("pauses, resumes, edits and deletes; blocks cross-user access and kind mismatches", async () => {
    const { token, acct, cat } = await setup();
    const other = await registerUser(c, "o@example.com");
    expect((await c.post("/v1/recurring", { accountId: acct.id, kind: "income", amountMinor: 1, categoryId: cat("Food").id, frequency: "daily", startOn: "2030-01-01" }, token)).body.error.code).toBe("category_kind_mismatch");
    expect((await c.post("/v1/recurring", { accountId: acct.id, kind: "expense", amountMinor: 1, frequency: "daily", startOn: "2030-01-01" }, other.token)).body.error.code).toBe("invalid_account");
    const rule = (await c.post("/v1/recurring", { accountId: acct.id, kind: "expense", amountMinor: 1_000, frequency: "daily", startOn: "2030-01-01" }, token)).body.data;
    expect((await c.get(`/v1/recurring/${rule.id}`, other.token)).status).toBe(404);
    const paused = (await c.patch(`/v1/recurring/${rule.id}`, { active: false, amountMinor: 2_000 }, token)).body.data;
    expect(paused).toMatchObject({ active: false, amountMinor: 2_000, nextDates: [] });
    expect((await c.patch(`/v1/recurring/${rule.id}`, { frequency: "weekly", interval: 2, active: true }, token)).body.data).toMatchObject({ frequency: "weekly", interval: 2, active: true, nextRunOn: "2030-01-01" });
    expect((await c.post("/v1/recurring/run-due", {}, token)).body.data).toMatchObject({ posted: 0 });
    expect((await c.del(`/v1/recurring/${rule.id}`, token)).status).toBe(204);
    expect((await c.get("/v1/recurring", token)).body.data).toHaveLength(0);
  });
});
