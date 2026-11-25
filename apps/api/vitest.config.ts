import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      FX_AUTO_REFRESH: "false",
      RECURRING_AUTO_RUN: "false",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://moneymgr:moneymgr@localhost:5432/moneymgr_test",
      JWT_SECRET: "test-secret-test-secret-test-secret-123",
      CORS_ORIGINS: "http://localhost:3000",
      MAIL_TRANSPORT: "memory",
      UPLOAD_DIR: "./.test-uploads",
      REDIS_URL: "",
    },
  },
});
