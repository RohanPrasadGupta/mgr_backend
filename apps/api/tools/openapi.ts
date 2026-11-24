/** Writes apps/api/openapi.json from the route registry. CI fails if the committed file is stale (`pnpm openapi && git diff`). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildOpenApi } from "@moneymgr/shared";

const out = path.resolve(__dirname, "../openapi.json");
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${out}`);
