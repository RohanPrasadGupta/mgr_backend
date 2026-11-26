import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";
import { genRequestId } from "../src/infra/request-log";
import { resetDb } from "./helpers";

describe("request log", () => {
  let app: NestFastifyApplication;
  const lines: string[] = [];
  const inject = (o: InjectOptions) => app.getHttpAdapter().getInstance().inject(o);

  beforeAll(async () => {
    app = await createApp({ logger: false, requestLog: (l) => lines.push(l) });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await resetDb(app);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { lines.length = 0; });

  it("writes one line per request with method, path, status, duration, IP and request id", async () => {
    const res = await inject({ method: "GET", url: "/v1/accounts", remoteAddress: "203.0.113.7" });
    expect(res.statusCode).toBe(401);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ WARN  GET \/v1\/accounts 401 \d+ms ip=203\.0\.113\.7 rid=[0-9a-f-]{36}$/);
    expect(lines[0]).toContain(`rid=${res.headers["x-request-id"]}`);
  });

  it("names the signed-in user, and never logs query strings, bodies or tokens", async () => {
    const email = `log-${Date.now()}@example.com`;
    const password = "correct horse battery";
    const reg = await inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, name: "Log Test", baseCurrency: "THB", timezone: "Asia/Bangkok" } });
    const { accessToken, user } = reg.json().data;
    await inject({ method: "GET", url: "/v1/transactions?limit=5&q=secret-search", headers: { authorization: `Bearer ${accessToken}` } });
    const all = lines.join("\n");
    expect(lines.at(-1)).toMatch(new RegExp(`GET /v1/transactions 200 \\d+ms ip=\\S+ user=${user.id} rid=`));
    for (const leak of [email, password, accessToken, "secret-search", "limit="]) expect(all).not.toContain(leak);
  });

  it("keeps a sane caller-supplied X-Request-Id and replaces anything else", async () => {
    const ok = await inject({ method: "GET", url: "/health", headers: { "x-request-id": "mobile-abc12345" } });
    expect(ok.headers["x-request-id"]).toBe("mobile-abc12345");
    const bad = await inject({ method: "GET", url: "/health", headers: { "x-request-id": "x y<script>" } });
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(genRequestId({ headers: { "x-request-id": "a".repeat(65) } } as never)).not.toBe("a".repeat(65));
  });

  it("skips successful health probes", async () => {
    await inject({ method: "GET", url: "/health" });
    expect(lines).toHaveLength(0);
  });
});

describe("request log (json format)", () => {
  it("writes one JSON object per line", async () => {
    const prev = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    const lines: string[] = [];
    const app = await createApp({ logger: false, requestLog: (l) => lines.push(l) });
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/nope?token=abc" });
      const entry = JSON.parse(lines[0]!);
      expect(entry).toMatchObject({ level: "warn", method: "GET", path: "/v1/nope", status: 404 });
      expect(typeof entry.ms).toBe("number");
      expect(lines[0]).not.toContain("token");
    } finally {
      process.env.LOG_FORMAT = prev;
      await app.close();
    }
  });
});
