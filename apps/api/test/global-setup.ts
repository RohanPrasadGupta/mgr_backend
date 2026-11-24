import { Pool } from "pg";
import { createDb } from "../src/db/db";
import { runMigrations } from "../src/db/migrate";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://moneymgr:moneymgr@localhost:5432/moneymgr_test";
  const admin = new Pool({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
  const dbName = new URL(url).pathname.slice(1);
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (!rowCount) await admin.query(`create database "${dbName.replace(/"/g, "")}"`);
  await admin.end();
  const { pool, db } = createDb(url);
  await runMigrations(db);
  await pool.end();
}
