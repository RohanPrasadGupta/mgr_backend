import { createApp } from "./bootstrap";
import { loadConfig } from "./config";

async function main() {
  const app = await createApp();
  await app.listen({ port: loadConfig().PORT, host: "0.0.0.0" });
}
main().catch((e) => { console.error(e); process.exit(1); });
