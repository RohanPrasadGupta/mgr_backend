import { loadConfig } from "../src/config";
import { createDb } from "../src/db/db";
import { FxService } from "../src/modules/fx/fx.service";

const config = loadConfig();
const { pool, db } = createDb(config.DATABASE_URL);
new FxService(db, config).refresh()
  .then((r) => console.log(`stored ${r.count} rates as of ${r.asOf}`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
