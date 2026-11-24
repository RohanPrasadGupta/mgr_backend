import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { SEED_CURRENCIES } from "@moneymgr/shared";
import fs from "node:fs";
import path from "node:path";
import { currencies } from "./schema";
import type { Db } from "./db";

export async function runMigrations(db: Db) {
  const candidates = [path.resolve(__dirname, "../../drizzle"), path.resolve(__dirname, "../drizzle"), path.resolve(process.cwd(), "drizzle")];
  const migrationsFolder = candidates.find((c) => fs.existsSync(path.join(c, "meta", "_journal.json")));
  if (!migrationsFolder) throw new Error("drizzle migrations folder not found");
  await migrate(db, { migrationsFolder });
  await db
    .insert(currencies)
    .values([...SEED_CURRENCIES])
    .onConflictDoUpdate({
      target: currencies.code,
      set: { name: sql`excluded.name`, symbol: sql`excluded.symbol`, minorUnit: sql`excluded.minor_unit` },
    });
}
