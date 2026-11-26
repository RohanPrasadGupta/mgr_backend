import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

describe("currencies", () => {
  it("offers the world's currencies with the right decimal places", async () => {
    const { token } = await registerUser(c);
    const all = (await c.get("/v1/currencies", token)).body.data as { code: string; minorUnit: number }[];
    expect(all.length).toBeGreaterThan(150);
    const by = new Map(all.map((x) => [x.code, x.minorUnit]));
    expect([by.get("THB"), by.get("NPR"), by.get("JPY"), by.get("KWD")]).toEqual([2, 2, 0, 3]);
  });

  it("each user keeps their own list: base first, grown by using a currency, edited in the profile", async () => {
    const { token } = await registerUser(c); // base THB
    expect((await c.get("/v1/me", token)).body.data.currencies).toEqual(["THB"]);

    await c.post("/v1/accounts", { name: "Nepal bank", type: "bank", currency: "NPR" }, token);
    await c.post("/v1/investments/assets", { symbol: "VOO", name: "Vanguard S&P 500", class: "fund", currency: "USD" }, token);
    await c.post("/v1/accounts", { name: "Second NPR", type: "cash", currency: "NPR" }, token); // already there: no duplicate
    expect((await c.get("/v1/me", token)).body.data.currencies).toEqual(["THB", "NPR", "USD"]);

    // edit the list; the base can't be dropped from it
    const edited = await c.patch("/v1/me", { currencies: ["NPR", "EUR"] }, token);
    expect(edited.body.data.currencies).toEqual(["THB", "NPR", "EUR"]);
    expect((await c.patch("/v1/me", { currencies: ["NPR", "XXX"] }, token)).body.error.code).toBe("unsupported_currency");

    // a new base currency joins the list
    expect((await c.patch("/v1/me", { baseCurrency: "SGD" }, token)).body.data.currencies).toEqual(["SGD", "THB", "NPR", "EUR"]);

    // other users are untouched
    const other = await registerUser(c, "other@example.com", { baseCurrency: "NPR" });
    expect((await c.get("/v1/me", other.token)).body.data.currencies).toEqual(["NPR"]);
  });

  it("imports add the currencies they bring in", async () => {
    const { token } = await registerUser(c);
    await c.post("/v1/imports/transactions", { rows: [{ date: "2025-01-01 10:00:00", account: "Cash", category: "Food", note: "", currency: "THB", amount: 10, type: "Expense" }] }, token);
    await c.post("/v1/imports/investments", { source: "sip-capital", rows: [{ _id: "s1", name: "Growth Fund", date: "2025-01-01T12:00:00.000Z", amount: 1000, currency: "NPR" }] }, token);
    expect((await c.get("/v1/me", token)).body.data.currencies).toEqual(["THB", "NPR"]);
  });
});
