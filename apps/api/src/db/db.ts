import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol("DB");
export const POOL = Symbol("POOL");
export const CONFIG = Symbol("CONFIG");

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool, { schema }) as Db };
}
createDb.fromPool = (pool: Pool): Db => drizzle(pool, { schema }) as Db;
