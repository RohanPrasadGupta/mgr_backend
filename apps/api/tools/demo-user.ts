/**
 * Creates the demo account App Store / Google Play reviewers sign in with, filled with realistic sample data.
 * It works through the public API (exactly like a user would), so it runs against your laptop or the live server:
 *
 *   DEMO_PASSWORD='…' pnpm --filter @moneymgr/api demo:user --api https://api.<host> --email review@<your-domain>
 *
 * Safe to re-run: if the account already has transactions it stops without changing anything.
 */
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

const API = (arg("api") ?? "http://localhost:8000").replace(/\/$/, "");
const EMAIL = arg("email");
const CURRENCY = (arg("currency") ?? "THB").toUpperCase();

/** Deterministic pseudo-random numbers, so every seeded demo account looks the same. */
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

async function askHidden(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => { if (s.includes(q)) out.output.write(s); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a); }));
}

async function main() {
  if (!EMAIL) throw new Error("usage: demo:user --api <url> --email <reviewer email> [--currency THB]  (password from DEMO_PASSWORD or a prompt)");
  const password = process.env.DEMO_PASSWORD || (await askHidden("Demo account password (min 8): "));
  if (password.length < 8) throw new Error("password must be at least 8 characters");

  let token = "";
  const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${API}/v1${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), "user-agent": "moneymgr-demo-seeder" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Json);
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`), { status: res.status });
    return json;
  };
  const data = async <T = Json>(method: string, path: string, body?: unknown) => (await call(method, path, body)).data as T;

  // Sign up, or sign in if the account exists.
  try {
    const r = await data<{ accessToken: string }>("POST", "/auth/register", { email: EMAIL, password, name: "App Review", baseCurrency: CURRENCY, timezone: "Asia/Bangkok" });
    token = r.accessToken;
    console.log(`created ${EMAIL}`);
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e;
    token = (await data<{ accessToken: string }>("POST", "/auth/login", { email: EMAIL, password })).accessToken;
    console.log(`signed in to existing ${EMAIL}`);
  }

  const existing = await call("GET", "/transactions?limit=1");
  if ((existing.data as unknown[]).length > 0) { console.log("already has data — nothing changed"); return; }

  const cats = await data<{ id: string; name: string; kind: string }[]>("GET", "/categories");
  const cat = (name: string, kind = "expense") => cats.find((c) => c.name === name && c.kind === kind)!.id;
  const cash = (await data<{ id: string; name: string }[]>("GET", "/accounts")).find((a) => a.name === "Cash")!;
  const bank = await data<{ id: string }>("POST", "/accounts", { name: "Bank account", type: "bank", currency: CURRENCY, openingBalanceMinor: 4_500_000 });
  const card = await data<{ id: string }>("POST", "/accounts", { name: "Credit card", type: "card", currency: CURRENCY });

  // Three months of everyday life.
  const rand = rng(42);
  const today = new Date();
  const day = (offset: number, hour = 12) => { const d = new Date(today); d.setDate(d.getDate() - offset); d.setHours(hour, Math.floor(rand() * 60), 0, 0); return d.toISOString(); };
  const thb = (n: number) => Math.round(n * 100);
  const spend: [string, string, [number, number], string, number][] = [ // category, account, amount range, note, times per month
    ["Food", cash.id, [60, 250], "Lunch", 14], ["Food", card.id, [400, 1500], "Groceries", 4], ["Transport", cash.id, [30, 120], "BTS", 12],
    ["Shopping", card.id, [300, 2500], "Shopping", 2], ["Entertainment", card.id, [200, 900], "Cinema", 2], ["Health", card.id, [150, 1200], "Pharmacy", 1],
  ];
  let n = 0;
  for (let m = 0; m < 3; m++) {
    const base = m * 30;
    await data("POST", "/transactions", { accountId: bank.id, kind: "income", amountMinor: thb(52_000), categoryId: cat("Salary", "income"), occurredAt: day(base + 25, 9), note: "Monthly salary" }); n++;
    await data("POST", "/transactions", { accountId: bank.id, kind: "expense", amountMinor: thb(12_000), categoryId: cat("Rent"), occurredAt: day(base + 24, 10), note: "Rent" }); n++;
    await data("POST", "/transfers", { fromAccountId: bank.id, toAccountId: cash.id, amountMinor: thb(4_000), occurredAt: day(base + 23, 11), note: "ATM" });
    await data("POST", "/transactions", { accountId: bank.id, kind: "expense", amountMinor: thb(1_850 + Math.round(rand() * 400)), categoryId: cat("Bills"), occurredAt: day(base + 20, 18), note: "Electricity & internet" }); n++;
    for (const [c, acc, [lo, hi], note, times] of spend) {
      for (let i = 0; i < times; i++) {
        const offset = base + Math.floor(rand() * 30);
        if (offset < 0) continue;
        await data("POST", "/transactions", { accountId: acc, kind: "expense", amountMinor: thb(lo + Math.round(rand() * (hi - lo))), categoryId: cat(c), occurredAt: day(offset, 8 + Math.floor(rand() * 12)), note }); n++;
      }
    }
  }

  await data("POST", "/budgets", { period: "month", amountMinor: thb(9_000), categoryId: cat("Food") });
  await data("POST", "/budgets", { period: "month", amountMinor: thb(3_000), categoryId: cat("Shopping") });
  const nextYear = new Date(today.getFullYear() + 1, today.getMonth(), 1).toISOString().slice(0, 10);
  await data("POST", "/goals", { name: "Emergency fund", targetMinor: thb(250_000), targetDate: nextYear, accountId: bank.id });
  await data("POST", "/recurring", { accountId: bank.id, kind: "expense", amountMinor: thb(12_000), categoryId: cat("Rent"), note: "Rent", frequency: "monthly", startOn: new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString().slice(0, 10) });
  await data("POST", "/notes", { title: "Tax documents", body: "Keep receipts for medical expenses and fund contributions until April.", pinned: true });

  const fund = await data<{ id: string }>("POST", "/investments/assets", { symbol: "GLOBAL-EQ", name: "Global equity fund", class: "fund", currency: CURRENCY });
  for (let m = 5; m >= 1; m--) await data("POST", "/investments/trades", { assetId: fund.id, type: "contribution", amountMinor: thb(3_000), tradedOn: day(m * 30).slice(0, 10) });
  await data("POST", "/investments/assets/" + fund.id + "/prices", { priceMinor: thb(16_200) }); // current total value (pooled asset)

  console.log(`✓ seeded ${n} transactions, 3 accounts, 2 budgets, a goal, a recurring rule, a note and an investment`);
  console.log(`  give the reviewers: ${EMAIL} + the password you chose`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
