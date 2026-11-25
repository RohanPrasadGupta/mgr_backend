import { defineConfig } from "tsup";
export default defineConfig({
  // main = the server; migrate = applies migrations then exits (run before each start); admin = the admin CLI (usable in the container)
  entry: { main: "src/main.ts", migrate: "src/db/migrate-cli.ts", admin: "tools/admin.ts" },
  format: ["cjs"],
  target: "node22",
  clean: true,
  noExternal: ["@moneymgr/shared"],
});
