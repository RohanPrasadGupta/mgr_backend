import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { createApp } from "../src/bootstrap";
import { DB, type Db } from "../src/db/db";

export async function makeApp() {
  const app = await createApp({ logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
export const resetDb = (app: NestFastifyApplication) => app.get<Db>(DB).execute(sql`truncate table users cascade`);

export function client(app: NestFastifyApplication) {
  const inst = app.getHttpAdapter().getInstance();
  const call = async (method: string, url: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await inst.inject({
      method: method as "GET", url,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
  };
  return {
    get: (u: string, t?: string) => call("GET", u, { token: t }),
    post: (u: string, b: unknown, t?: string) => call("POST", u, { token: t, body: b }),
    patch: (u: string, b: unknown, t?: string) => call("PATCH", u, { token: t, body: b }),
    del: (u: string, t?: string) => call("DELETE", u, { token: t }),
  };
}

export async function registerUser(c: ReturnType<typeof client>, email = "a@example.com", extra: object = {}) {
  const r = await c.post("/v1/auth/register", { email, password: "password123", name: "Tester", baseCurrency: "THB", timezone: "Asia/Bangkok", ...extra });
  return { token: r.body.data.accessToken as string, refresh: r.body.data.refreshToken as string, user: r.body.data.user };
}
