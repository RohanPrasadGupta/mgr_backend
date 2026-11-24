import { loadConfig } from "../config";
import { createDb } from "./db";
import { runMigrations } from "./migrate";

const { pool, db } = createDb(loadConfig().DATABASE_URL);
runMigrations(db)
  .then(() => console.log("migrations applied"))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
