import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { BREVO_URL, Mailer, parseAddress } from "../src/infra/mailer";

const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "x".repeat(32) };
const mail = { to: "user@example.com", subject: "Hi", text: "plain", html: "<p>html</p>" };

function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseAddress", () => {
  it("reads 'Name <email>' and a bare email", () => {
    expect(parseAddress("MoneyMgr <hi@example.com>")).toEqual({ name: "MoneyMgr", email: "hi@example.com" });
    expect(parseAddress('"Money Mgr" <hi@example.com>')).toEqual({ name: "Money Mgr", email: "hi@example.com" });
    expect(parseAddress("hi@example.com")).toEqual({ email: "hi@example.com" });
    expect(() => parseAddress("MoneyMgr")).toThrow(/not an email/);
  });
});

describe("Brevo transport", () => {
  const config = loadConfig({ ...base, MAIL_TRANSPORT: "brevo", BREVO_API_KEY: "xkeysib-test", MAIL_FROM: "MoneyMgr <hi@example.com>" });

  it("needs an API key, and a real sender address at start-up", () => {
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: "brevo" })).toThrow(/BREVO_API_KEY/);
    expect(() => new Mailer({ ...config, MAIL_FROM: "MoneyMgr" })).toThrow(/MAIL_FROM/);
  });

  it("posts the email to Brevo's API with the key in the header", async () => {
    const f = fakeFetch(201, { messageId: "<1@brevo>" });
    await new Mailer(config, f.fn).send(mail);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(BREVO_URL);
    expect((f.calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      sender: { name: "MoneyMgr", email: "hi@example.com" }, to: [{ email: "user@example.com" }],
      subject: "Hi", htmlContent: "<p>html</p>", textContent: "plain",
    });
  });

  it("fails with Brevo's reason and without leaking the key", async () => {
    const f = fakeFetch(400, { code: "invalid_parameter", message: "sender is not valid" });
    const err = await new Mailer(config, f.fn).send(mail).catch((e: Error) => e);
    expect((err as Error).message).toBe("Brevo 400: sender is not valid");
    expect((err as Error).message).not.toContain("xkeysib");
  });
});
