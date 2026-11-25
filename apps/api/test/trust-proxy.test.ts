import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { desc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { DB, type Db } from "../src/db/db";
import { auditLog } from "../src/db/schema";
import { makeApp, resetDb } from "./helpers";

describe("TRUST_PROXY", () => {
  it("parses true/false and address lists", () => {
    const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "x".repeat(32) };
    expect(loadConfig(base).TRUST_PROXY).toBe(true); // local default
    expect(loadConfig({ ...base, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "172.28.0.0/24" }).TRUST_PROXY).toBe("172.28.0.0/24");
  });

  describe("with only the proxy network trusted", () => {
    let app: NestFastifyApplication;
    const prev = process.env.TRUST_PROXY;
    beforeAll(async () => { process.env.TRUST_PROXY = "10.0.0.0/8"; app = await makeApp(); await resetDb(app); });
    afterAll(async () => { process.env.TRUST_PROXY = prev; await app.close(); });

    const failedLoginIp = async (remoteAddress: string) => {
      await app.getHttpAdapter().getInstance().inject({
        method: "POST", url: "/v1/admin/auth/login", remoteAddress,
        headers: { "x-forwarded-for": "6.6.6.6" }, payload: { email: `nobody-${Math.random()}@example.com`, password: "wrong" },
      });
      const [row] = await app.get<Db>(DB).select({ ip: auditLog.ip }).from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1);
      return row?.ip;
    };

    it("ignores X-Forwarded-For from anyone else (a client can't pick its own IP)", async () => {
      expect(await failedLoginIp("203.0.113.9")).toBe("203.0.113.9");
    });
    it("believes it from the proxy", async () => {
      expect(await failedLoginIp("10.1.2.3")).toBe("6.6.6.6");
    });
  });
});
