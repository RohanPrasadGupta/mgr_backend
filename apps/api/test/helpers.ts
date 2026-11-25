import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { apiResponses, matchRoute } from "@moneymgr/shared";
import { createApp } from "../src/bootstrap";
import { DB, type Db } from "../src/db/db";

export async function makeApp() {
  const app = await createApp({ logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
export const resetDb = (app: NestFastifyApplication) => app.get<Db>(DB).execute(sql`truncate table users cascade`);

/**
 * Every API call made by any test is checked against the OpenAPI contract (route registry in @moneymgr/shared):
 * success bodies must match the documented schema and status, error bodies must match ErrorBody.
 * So the whole integration suite doubles as a contract test and the generated clients can't silently drift.
 */
function assertContract(method: string, url: string, status: number, body: unknown) {
  if (!url.startsWith("/v1/")) return;
  const path = url.slice(3).split("?")[0]!;
  const where = `${method} ${path} → ${status}`;
  if (status >= 400) {
    const r = apiResponses.ErrorBody.safeParse(body);
    if (!r.success) throw new Error(`Contract: error body of ${where} does not match ErrorBody: ${JSON.stringify(r.error.issues)}`);
    return;
  }
  const route = matchRoute(method, path);
  if (!route) throw new Error(`Contract: ${where} is not in the OpenAPI route registry`);
  if (status !== route.status) throw new Error(`Contract: ${where} but ${route.operationId} documents ${route.status}`);
  if (route.binary) return;
  if (route.response === null) { if (body !== undefined) throw new Error(`Contract: ${where} should have no body`); return; }
  const r = route.response.safeParse(body);
  if (!r.success) throw new Error(`Contract: response of ${route.operationId} (${where}) does not match its schema: ${JSON.stringify(r.error.issues.slice(0, 5))}`);
}

export function client(app: NestFastifyApplication) {
  const inst = app.getHttpAdapter().getInstance();
  const call = async (method: string, url: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await inst.inject({
      method: method as "GET", url,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
    const isJson = String(res.headers["content-type"] ?? "").includes("json");
    const body = res.body && isJson ? (JSON.parse(res.body) as any) : undefined;
    assertContract(method, url, res.statusCode, body);
    return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
  };
  /** multipart/form-data upload with one part (default field `file`). */
  const upload = async (url: string, data: Buffer, fileName: string, token?: string, opts: { field?: string; contentType?: string } = {}) => {
    const boundary = "----mmtest" + Math.random().toString(16).slice(2);
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${opts.field ?? "file"}"; filename="${fileName}"\r\nContent-Type: ${opts.contentType ?? "application/octet-stream"}\r\n\r\n`;
    const payload = Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await inst.inject({ method: "POST", url, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const body = res.body ? (JSON.parse(res.body) as any) : undefined;
    assertContract("POST", url, res.statusCode, body);
    return { status: res.statusCode, body };
  };
  return {
    get: (u: string, t?: string) => call("GET", u, { token: t }),
    post: (u: string, b: unknown, t?: string) => call("POST", u, { token: t, body: b }),
    patch: (u: string, b: unknown, t?: string) => call("PATCH", u, { token: t, body: b }),
    del: (u: string, t?: string, b?: unknown) => call("DELETE", u, { token: t, body: b }),
    upload,
  };
}

export async function registerUser(c: ReturnType<typeof client>, email = "a@example.com", extra: object = {}) {
  const r = await c.post("/v1/auth/register", { email, password: "password123", name: "Tester", baseCurrency: "THB", timezone: "Asia/Bangkok", ...extra });
  return { token: r.body.data.accessToken as string, refresh: r.body.data.refreshToken as string, user: r.body.data.user };
}
