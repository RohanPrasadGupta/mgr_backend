/**
 * One-off importer for the v1 "Money Manager" export (.xls / .xlsx / .csv).
 *   pnpm --filter @moneymgr/api import:v1 -- --file "/path/Money Manager.xls" --email you@example.com [--dry-run]
 * Columns (real v1 export): Date, Account, Category, Subcategory, Note, THB, Income/Expense, Description, Amount, Currency, Account
 * (`Amount` is in `Currency`; `THB` is the same value converted — we import Amount + Currency and let FX handle the rest.)
 * Re-running is safe: rows are de-duplicated with a deterministic clientId.
 * NOTE: `xlsx` (SheetJS 0.18.x) has known CVEs for *untrusted* files — only feed it your own export.
 */
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/db";
import { users } from "../src/db/schema";
import { FxService } from "../src/modules/fx/fx.service";
import { ImportsService } from "../src/modules/imports/imports.service";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const pad = (n: number) => String(n).padStart(2, "0");

function cellToDate(v: unknown): string | null {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}` : null;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  if (typeof v === "string") {
    // Text cells in the real export are "DD/MM/YYYY HH:mm:ss"; the HTML rendering is date-only "M/D/YYYY".
    const dt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
    if (dt) return `${dt[3]}-${pad(+dt[2]!)}-${pad(+dt[1]!)} ${pad(+dt[4]!)}:${dt[5]}:${dt[6] ?? "00"}`;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
    if (m) return `${m[3]}-${pad(+m[1]!)}-${pad(+m[2]!)}`;
    return v.trim();
  }
  return null;
}

async function main() {
  const file = arg("file"), email = arg("email")?.toLowerCase();
  if (!file || !email) throw new Error("usage: --file <path> --email <user email> [--dry-run]");
  const wb = XLSX.readFile(file, { cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true });
  console.log(`read ${raw.length} rows from "${wb.SheetNames[0]}"; columns: ${Object.keys(raw[0] ?? {}).join(", ")}`);

  const rows = raw.map((r) => {
    const get = (...keys: string[]) => keys.map((k) => r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()]).find((x) => x !== undefined);
    const type = String(get("Income/Expense", "type", "Type") ?? "").trim();
    return {
      date: cellToDate(get("Date", "date")) ?? "",
      account: String(get("Account", "account") ?? "").trim(),
      category: String(get("Category", "category") ?? "").trim(),
      note: String(get("Note", "note", "Description") ?? ""),
      currency: String(get("Currency", "currency") ?? "THB").trim(),
      amount: Number(get("Amount", "amount")),
      type,
    };
  });

  const config = loadConfig();
  const { pool, db } = createDb(config.DATABASE_URL);
  try {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) throw new Error(`no user with email ${email}; register first`);
    const svc = new ImportsService(db, new FxService(db, config));
    const report = await svc.importTransactions(user.id, rows, process.argv.includes("--dry-run"));
    console.log(JSON.stringify({ ...report, invalid: report.invalid.slice(0, 20), invalidCount: report.invalid.length }, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
