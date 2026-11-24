import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { RecurringService } from "../src/modules/recurring/recurring.service";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

/** Gives the user a row in every user-owned table. */
async function populate(email: string) {
  const u = await registerUser(c, email);
  const [cash] = (await c.get("/v1/accounts", u.token)).body.data;
  const bank = (await c.post("/v1/accounts", { name: "Bank", type: "bank", currency: "THB" }, u.token)).body.data;
  const food = (await c.get("/v1/categories", u.token)).body.data.find((x: any) => x.name === "Food");
  await c.post("/v1/categories", { name: "Coffee", kind: "expense", parentId: food.id }, u.token);
  await c.post("/v1/transactions", { accountId: cash.id, kind: "expense", amountMinor: 1000, categoryId: food.id }, u.token);
  await c.post("/v1/transfers", { fromAccountId: cash.id, toAccountId: bank.id, amountMinor: 500 }, u.token);
  await c.post("/v1/budgets", { period: "month", amountMinor: 5000, categoryId: food.id }, u.token);
  await c.post("/v1/recurring", { accountId: cash.id, kind: "expense", amountMinor: 100, frequency: "daily", startOn: "2025-01-01", backfill: true }, u.token);
  await app.get(RecurringService).runDue({ userId: undefined, now: new Date("2025-01-03T05:00:00Z") }); // posts transactions that reference the rule
  const asset = (await c.post("/v1/investments/assets", { symbol: "PTT", name: "PTT", class: "stock", currency: "THB" }, u.token)).body.data;
  await c.post("/v1/investments/trades", { assetId: asset.id, type: "buy", quantity: 1, priceMinor: 100, tradedOn: "2025-01-01" }, u.token);
  await c.post(`/v1/investments/assets/${asset.id}/prices`, { priceMinor: 120 }, u.token);
  return u;
}

async function rowsOwnedBy(userId: string) {
  const db = app.get<Db>(DB);
  const q = async (table: string, col = "user_id") => Number((await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${col} = '${userId}'`))).rows[0]!.n);
  return {
    users: await q("users", "id"), refresh: await q("refresh_tokens"), accounts: await q("accounts"), categories: await q("categories"), transactions: await q("transactions"),
    budgets: await q("budgets"), recurring: await q("recurring_rules"), assets: await q("assets"), trades: await q("trades"),
    prices: Number((await db.execute(sql.raw(`select count(*)::int as n from asset_prices where asset_id in (select id from assets where user_id = '${userId}')`))).rows[0]!.n),
  };
}

describe("DELETE /v1/me", () => {
  it("erases every row the user owns, leaves other users untouched, and ends all sessions", async () => {
    const a = await populate("a@example.com");
    const b = await populate("b@example.com");
    const before = await rowsOwnedBy(a.user.id);
    expect(Object.values(before).every((n) => n > 0)).toBe(true); // the fixture really touched every table (recurring-posted transactions included)
    const beforeB = await rowsOwnedBy(b.user.id);

    const res = await c.del("/v1/me", a.token, { password: "password123" });
    expect(res.status).toBe(204);

    expect(Object.values(await rowsOwnedBy(a.user.id)).every((n) => n === 0)).toBe(true);
    expect(await rowsOwnedBy(b.user.id)).toEqual(beforeB);

    expect((await c.post("/v1/auth/login", { email: "a@example.com", password: "password123" })).status).toBe(401);
    expect((await c.post("/v1/auth/refresh", { refreshToken: a.refresh })).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email: "b@example.com", password: "password123" })).status).toBe(200);
  });

  it("frees the email for a fresh registration", async () => {
    const a = await registerUser(c, "again@example.com");
    expect((await c.del("/v1/me", a.token, { password: "password123" })).status).toBe(204);
    const again = await c.post("/v1/auth/register", { email: "again@example.com", password: "password123", name: "New" });
    expect(again.status).toBe(201);
    expect((await c.get("/v1/transactions", again.body.data.accessToken)).body.data).toHaveLength(0);
  });

  it("refuses a wrong password and deletes nothing", async () => {
    const a = await populate("w@example.com");
    const before = await rowsOwnedBy(a.user.id);
    const res = await c.del("/v1/me", a.token, { password: "not-my-password" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("incorrect_password");
    expect(await rowsOwnedBy(a.user.id)).toEqual(before);
    expect((await c.get("/v1/me", a.token)).status).toBe(200);
  });

  it("requires a password in the body and a valid session", async () => {
    const a = await registerUser(c, "v@example.com");
    expect((await c.del("/v1/me", a.token, {})).status).toBe(400);
    expect((await c.del("/v1/me", a.token)).status).toBe(400);
    expect((await c.del("/v1/me", undefined, { password: "password123" })).status).toBe(401);
    expect((await c.get("/v1/me", a.token)).status).toBe(200);
  });

  it("locks after five wrong passwords, even for the right one", async () => {
    const a = await registerUser(c, "l@example.com");
    for (let i = 0; i < 5; i++) expect((await c.del("/v1/me", a.token, { password: "nope" + i })).status).toBe(403);
    const locked = await c.del("/v1/me", a.token, { password: "password123" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("too_many_attempts");
    expect((await c.get("/v1/me", a.token)).status).toBe(200); // account still there
  });

  it("a leftover access token of a deleted account cannot create data (clean 401, not a 500)", async () => {
    const a = await registerUser(c, "t@example.com");
    expect((await c.del("/v1/me", a.token, { password: "password123" })).status).toBe(204);
    const r = await c.post("/v1/accounts", { name: "Ghost", type: "cash", currency: "THB" }, a.token);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect((await c.get("/v1/accounts", a.token)).body.data).toEqual([]);
  });
});
