import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Each test file runs in its own module graph, so this low limit only applies here.
process.env.AUTH_RATE_LIMIT_PER_MIN = "3";
const { client, makeApp, resetDb } = await import("./helpers");

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
beforeAll(async () => { app = await makeApp(); c = client(app); await resetDb(app); });
afterAll(async () => { await app.close(); delete process.env.AUTH_RATE_LIMIT_PER_MIN; });

describe("per-IP limit on auth endpoints", () => {
  it("allows AUTH_RATE_LIMIT_PER_MIN requests per minute to /auth/login, then 429", async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post("/v1/auth/login", { email: `n${i}@example.com`, password: "whatever" })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
  it("counts each auth route separately and leaves the rest of the API at the global limit", async () => {
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await c.post("/v1/auth/forgot-password", { email: "x@example.com" })).status);
    expect(r).toEqual([202, 202, 202, 429]);
    for (let i = 0; i < 6; i++) expect((await c.get("/health")).status).toBe(200);
  });
});
