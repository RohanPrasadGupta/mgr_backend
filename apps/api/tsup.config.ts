import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  target: "node22",
  clean: true,
  noExternal: ["@moneymgr/shared"],
});
