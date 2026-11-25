import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { goalProgress } from "../src/modules/goals/goals";
import { sniff } from "../src/modules/attachments/attachments";
import { reportWindow } from "../src/modules/reports/reports";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); });
afterAll(async () => { await app.close(); });

let t: string; let cashId: string; let food: string; let salary: string;
beforeEach(async () => {
  await resetDb(app);
  t = (await registerUser(c, "p@example.com")).token;
  cashId = (await c.get("/v1/accounts", t)).body.data[0].id;
  const cats = (await c.get("/v1/categories", t)).body.data;
  food = cats.find((x: any) => x.name === "Food").id;
  salary = cats.find((x: any) => x.name === "Salary").id;
});
const tx = (o: object) => c.post("/v1/transactions", { accountId: cashId, kind: "expense", amountMinor: 1000, ...o }, t);

describe("tags", () => {
  it("CRUD with case-insensitive unique names and usage counts", async () => {
    const trip = (await c.post("/v1/tags", { name: "Trip", color: "#f00" }, t)).body.data;
    expect(trip).toMatchObject({ name: "Trip", usageCount: 0 });
    expect((await c.post("/v1/tags", { name: "trip" }, t)).status).toBe(409);
    await tx({ tagIds: [trip.id] });
    expect((await c.get("/v1/tags", t)).body.data[0].usageCount).toBe(1);
    expect((await c.patch(`/v1/tags/${trip.id}`, { name: "Holiday" }, t)).body.data).toMatchObject({ name: "Holiday", usageCount: 1 });
    expect((await c.del(`/v1/tags/${trip.id}`, t)).status).toBe(204);
    expect((await c.get("/v1/transactions", t)).body.data[0].tagIds).toEqual([]);
  });

  it("transactions carry tagIds; PATCH replaces the set; list filters by tag; foreign tags are rejected", async () => {
    const a = (await c.post("/v1/tags", { name: "a" }, t)).body.data.id;
    const b = (await c.post("/v1/tags", { name: "b" }, t)).body.data.id;
    const one = (await tx({ tagIds: [a, b, a] })).body.data;
    expect(one.tagIds.sort()).toEqual([a, b].sort());
    await tx({ note: "untagged" });
    expect((await c.patch(`/v1/transactions/${one.id}`, { tagIds: [b] }, t)).body.data.tagIds).toEqual([b]);
    const byB = (await c.get(`/v1/transactions?tagId=${b}`, t)).body.data;
    expect(byB.map((x: any) => x.id)).toEqual([one.id]);
    expect((await c.get(`/v1/transactions?tagId=${a}`, t)).body.data).toEqual([]);
    const other = await registerUser(c, "other@example.com");
    const theirs = (await c.post("/v1/tags", { name: "x" }, other.token)).body.data.id;
    expect((await tx({ tagIds: [theirs] })).body.error.code).toBe("invalid_tag");
  });
});

describe("attachments", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  it("sniffs the real type and rejects disguised files", () => {
    expect(sniff(png)).toBe("image/png");
    expect(sniff(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
  });

  it("upload → list → download (safe headers) → delete; counts show on the transaction", async () => {
    const id = (await tx({})).body.data.id;
    const up = await c.upload(`/v1/transactions/${id}/attachments`, png, "../../etc/receipt.png", t, { contentType: "text/html" });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ fileName: "receipt.png", contentType: "image/png", sizeBytes: png.length });
    expect((await c.get(`/v1/transactions/${id}`, t)).body.data.attachmentCount).toBe(1);
    expect((await c.get(`/v1/transactions/${id}/attachments`, t)).body.data).toHaveLength(1);
    const dl = await c.get(`/v1/attachments/${up.body.data.id}/file`, t);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toBe("image/png");
    expect(dl.headers["cache-control"]).toBe("private, no-store");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(dl.raw, png)).toBe(0);
    expect((await c.del(`/v1/attachments/${up.body.data.id}`, t)).status).toBe(204);
    expect((await c.get(`/v1/attachments/${up.body.data.id}/file`, t)).status).toBe(404);
  });

  it("refuses unsupported types, oversized files, other users' transactions, and non-multipart requests", async () => {
    const id = (await tx({})).body.data.id;
    expect((await c.upload(`/v1/transactions/${id}/attachments`, Buffer.from("<svg onload=alert(1)>"), "x.svg", t)).status).toBe(415);
    expect((await c.upload(`/v1/transactions/${id}/attachments`, Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(10 * 1024 * 1024 + 10)]), "big.pdf", t)).status).toBe(413);
    const other = await registerUser(c, "o@example.com");
    expect((await c.upload(`/v1/transactions/${id}/attachments`, png, "x.png", other.token)).status).toBe(404);
    expect((await c.post(`/v1/transactions/${id}/attachments`, { file: "nope" }, t)).status).toBe(415);
  });

  it("deleting the transaction deletes its attachments", async () => {
    const id = (await tx({})).body.data.id;
    const a = (await c.upload(`/v1/transactions/${id}/attachments`, png, "x.png", t)).body.data.id;
    await c.del(`/v1/transactions/${id}`, t);
    expect((await c.get(`/v1/attachments/${a}/file`, t)).status).toBe(404);
  });
});

describe("goals", () => {
  it("progress maths: reached, no deadline, overdue, on track vs behind, monthly needed", () => {
    const g = (targetDate: string | null, created = "2026-01-01") => ({ targetMinor: 120_000, targetDate, createdAt: new Date(`${created}T00:00:00Z`) });
    expect(goalProgress(g(null), 130_000, "2026-06-01").status).toBe("reached");
    expect(goalProgress(g(null), 10_000, "2026-06-01")).toMatchObject({ status: "no_deadline", monthlyNeededMinor: null, remainingMinor: 110_000 });
    expect(goalProgress(g("2026-05-01"), 10_000, "2026-06-01").status).toBe("overdue");
    // half the time gone (Jan 1 → Dec 31, today ~Jul 2): 50% saved is on track, 20% is behind
    expect(goalProgress(g("2026-12-31"), 60_000, "2026-07-02").status).toBe("on_track");
    const behind = goalProgress(g("2026-12-31"), 24_000, "2026-07-02");
    expect(behind.status).toBe("behind");
    expect(behind.monthlyNeededMinor).toBe(16_000); // 96,000 left over 6 months
  });

  it("manual contributions drive progress; withdrawals are negative; detail lists them", async () => {
    const goal = (await c.post("/v1/goals", { name: "Laptop", targetMinor: 50_000 }, t)).body.data;
    expect(goal).toMatchObject({ currency: "THB", source: "contributions", savedMinor: 0, pct: 0, status: "no_deadline" });
    await c.post(`/v1/goals/${goal.id}/contributions`, { amountMinor: 30_000, occurredOn: "2026-01-05" }, t);
    const w = (await c.post(`/v1/goals/${goal.id}/contributions`, { amountMinor: -5_000, note: "oops" }, t)).body.data;
    const d = (await c.get(`/v1/goals/${goal.id}`, t)).body.data;
    expect(d.goal).toMatchObject({ savedMinor: 25_000, remainingMinor: 25_000, pct: 50 });
    expect(d.contributions).toHaveLength(2);
    expect((await c.post(`/v1/goals/${goal.id}/contributions`, { amountMinor: 0 }, t)).status).toBe(400);
    await c.del(`/v1/goals/${goal.id}/contributions/${w.id}`, t);
    expect((await c.get("/v1/goals", t)).body.data[0].savedMinor).toBe(30_000);
  });

  it("a goal linked to an account tracks its balance and refuses manual contributions", async () => {
    const savings = (await c.post("/v1/accounts", { name: "Savings", type: "bank", currency: "THB", openingBalanceMinor: 40_000 }, t)).body.data;
    const goal = (await c.post("/v1/goals", { name: "Emergency", targetMinor: 100_000, accountId: savings.id }, t)).body.data;
    expect(goal).toMatchObject({ source: "account", savedMinor: 40_000, pct: 40 });
    await c.post("/v1/transfers", { fromAccountId: cashId, toAccountId: savings.id, amountMinor: 10_000 }, t);
    expect((await c.get(`/v1/goals/${goal.id}`, t)).body.data.goal.savedMinor).toBe(50_000);
    expect((await c.post(`/v1/goals/${goal.id}/contributions`, { amountMinor: 1 }, t)).body.error.code).toBe("goal_linked_to_account");
    const usd = (await c.post("/v1/accounts", { name: "USD", type: "bank", currency: "USD" }, t)).body.data;
    expect((await c.patch(`/v1/goals/${goal.id}`, { accountId: usd.id }, t)).body.error.code).toBe("currency_mismatch");
  });

  it("archive hides a goal from the default list; delete removes it", async () => {
    const goal = (await c.post("/v1/goals", { name: "Old", targetMinor: 1000 }, t)).body.data;
    await c.patch(`/v1/goals/${goal.id}`, { archived: true }, t);
    expect((await c.get("/v1/goals", t)).body.data).toEqual([]);
    expect((await c.get("/v1/goals?archived=true", t)).body.data).toHaveLength(1);
    expect((await c.del(`/v1/goals/${goal.id}`, t)).status).toBe(204);
    expect((await c.get(`/v1/goals/${goal.id}`, t)).status).toBe(404);
  });
});

describe("debts", () => {
  it("tracks repayments to settlement, refuses overpayment, and summarises per currency", async () => {
    const lent = (await c.post("/v1/debts", { direction: "lent", counterparty: "Ronit", principalMinor: 70_000, startedOn: "2026-01-01" }, t)).body.data;
    await c.post("/v1/debts", { direction: "borrowed", counterparty: "Bank", principalMinor: 20_000, currency: "USD", dueOn: "2020-01-01", startedOn: "2019-01-01" }, t);
    expect(lent).toMatchObject({ outstandingMinor: 70_000, status: "open", currency: "THB" });
    await c.post(`/v1/debts/${lent.id}/payments`, { amountMinor: 50_000, paidOn: "2026-02-01" }, t);
    expect((await c.post(`/v1/debts/${lent.id}/payments`, { amountMinor: 30_000 }, t)).body.error.code).toBe("overpayment");
    const s = (await c.get("/v1/debts/summary", t)).body.data;
    expect(s).toMatchObject({ openCount: 2, overdueCount: 1 });
    expect(s.totals).toEqual([
      { currency: "THB", owedToMeMinor: 20_000, iOweMinor: 0, netMinor: 20_000 },
      { currency: "USD", owedToMeMinor: 0, iOweMinor: 20_000, netMinor: -20_000 },
    ]);
    const p = (await c.post(`/v1/debts/${lent.id}/payments`, { amountMinor: 20_000 }, t)).body.data;
    expect((await c.get(`/v1/debts/${lent.id}`, t)).body.data.debt).toMatchObject({ status: "settled", outstandingMinor: 0, paidMinor: 70_000 });
    expect((await c.get("/v1/debts", t)).body.data.map((d: any) => d.counterparty)).toEqual(["Bank"]);
    expect((await c.get("/v1/debts?status=settled", t)).body.data.map((d: any) => d.counterparty)).toEqual(["Ronit"]);
    expect((await c.patch(`/v1/debts/${lent.id}`, { principalMinor: 10_000 }, t)).body.error.code).toBe("principal_below_paid");
    await c.del(`/v1/debts/${lent.id}/payments/${p.id}`, t);
    expect((await c.get(`/v1/debts/${lent.id}`, t)).body.data.debt.status).toBe("open");
    expect((await c.del(`/v1/debts/${lent.id}`, t)).status).toBe(204);
  });
  it("validates dates", async () => {
    expect((await c.post("/v1/debts", { direction: "lent", counterparty: "A", principalMinor: 1, startedOn: "2026-02-01", dueOn: "2026-01-01" }, t)).status).toBe(400);
  });
});

describe("notes", () => {
  it("CRUD, pinned first, search title/body, isolated per user", async () => {
    const a = (await c.post("/v1/notes", { title: "Groceries", body: "milk, eggs" }, t)).body.data;
    await new Promise((r) => setTimeout(r, 5));
    await c.post("/v1/notes", { title: "Tax", body: "file by March" }, t);
    await c.patch(`/v1/notes/${a.id}`, { pinned: true }, t);
    expect((await c.get("/v1/notes", t)).body.data.map((n: any) => n.title)).toEqual(["Groceries", "Tax"]);
    expect((await c.get("/v1/notes?q=march", t)).body.data.map((n: any) => n.title)).toEqual(["Tax"]);
    expect((await c.get("/v1/notes?q=100%25", t)).body.data).toEqual([]); // wildcards are literal
    const other = await registerUser(c, "n2@example.com");
    expect((await c.get("/v1/notes", other.token)).body.data).toEqual([]);
    expect((await c.patch(`/v1/notes/${a.id}`, { title: "x" }, other.token)).status).toBe(404);
    expect((await c.del(`/v1/notes/${a.id}`, t)).status).toBe(204);
  });
});

describe("reports", () => {
  it("windows: month (incl. January → previous December) and year", () => {
    expect(reportWindow({ period: "month", year: 2026, month: 1 })).toMatchObject({ label: "January 2026", from: "2026-01-01", to: "2026-01-31", previousFrom: "2025-12-01", previousTo: "2025-12-31" });
    expect(reportWindow({ period: "year", year: 2025 })).toMatchObject({ from: "2025-01-01", to: "2025-12-31", previousFrom: "2024-01-01" });
  });

  it("monthly report: totals, comparison, categories with change, daily series, top expenses, accounts", async () => {
    const at = (d: string) => `${d}T05:00:00Z`;
    await tx({ amountMinor: 30_000, categoryId: food, occurredAt: at("2026-03-03"), note: "big dinner" });
    await tx({ amountMinor: 10_000, categoryId: food, occurredAt: at("2026-03-10") });
    await tx({ amountMinor: 20_000, occurredAt: at("2026-03-10") });
    await c.post("/v1/transactions", { accountId: cashId, kind: "income", amountMinor: 100_000, categoryId: salary, occurredAt: at("2026-03-01") }, t);
    await tx({ amountMinor: 20_000, categoryId: food, occurredAt: at("2026-02-15") });
    const r = (await c.get("/v1/reports?period=month&year=2026&month=3", t)).body.data;
    expect(r).toMatchObject({ label: "March 2026", incomeMinor: 100_000, expenseMinor: 60_000, netMinor: 40_000, savingsRatePct: 40, transactionCount: 4, previous: { expenseMinor: 20_000 } });
    expect(r.series).toHaveLength(31);
    expect(r.series[9]).toMatchObject({ label: "10", expenseMinor: 30_000 });
    const foodRow = r.expenseByCategory.find((x: any) => x.name === "Food");
    expect(foodRow).toMatchObject({ totalMinor: 40_000, previousMinor: 20_000, changePct: 100 });
    expect(r.expenseByCategory.find((x: any) => x.name === "Uncategorised").changePct).toBeNull();
    expect(r.topExpenses[0]).toMatchObject({ amountMinor: 30_000, categoryName: "Food", note: "big dinner", accountName: "Cash" });
    expect(r.byAccount).toEqual([expect.objectContaining({ name: "Cash", incomeMinor: 100_000, expenseMinor: 60_000 })]);
    expect(r.avgDailyExpenseMinor).toBe(Math.round(60_000 / 31));
  });

  it("yearly report: 12 monthly buckets; month is required for a monthly report", async () => {
    await tx({ amountMinor: 5_000, occurredAt: "2025-07-15T05:00:00Z" });
    const r = (await c.get("/v1/reports?period=year&year=2025", t)).body.data;
    expect(r.series.map((s: any) => s.label)).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(r.series[6]).toMatchObject({ from: "2025-07-01", to: "2025-07-31", expenseMinor: 5_000 });
    expect(r.series[1].to).toBe("2025-02-28");
    expect((await c.get("/v1/reports?period=month&year=2025", t)).status).toBe(400);
  });
});
