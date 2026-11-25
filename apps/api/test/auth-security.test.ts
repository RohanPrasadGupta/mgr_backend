import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAILER, type Mailer } from "../src/infra/mailer";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
let mail: Mailer;
beforeAll(async () => { app = await makeApp(); c = client(app); mail = app.get(MAILER); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); mail.sent.length = 0; });

const linkToken = (text: string, path: string) => new URL(text.match(new RegExp(`https?://\\S+${path}\\?token=\\S+`))![0]).searchParams.get("token")!;
const lastMailTo = (to: string) => [...mail.sent].reverse().find((m) => m.to === to)!;

describe("sign-in lockout", () => {
  it("locks an email after 5 failures (even with the right password next), without revealing whether it exists", async () => {
    await registerUser(c, "lock@example.com");
    for (let i = 0; i < 5; i++) expect((await c.post("/v1/auth/login", { email: "lock@example.com", password: "wrong-password" })).status).toBe(401);
    const locked = await c.post("/v1/auth/login", { email: "lock@example.com", password: "password123" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("too_many_attempts");
    // unknown emails lock the same way
    for (let i = 0; i < 5; i++) await c.post("/v1/auth/login", { email: "ghost@example.com", password: "x" });
    expect((await c.post("/v1/auth/login", { email: "ghost@example.com", password: "x" })).status).toBe(429);
    // other accounts are unaffected
    await registerUser(c, "other@example.com");
    expect((await c.post("/v1/auth/login", { email: "other@example.com", password: "password123" })).status).toBe(200);
  });

  it("a successful sign-in clears earlier failures", async () => {
    await registerUser(c, "reset-count@example.com");
    for (let i = 0; i < 4; i++) await c.post("/v1/auth/login", { email: "reset-count@example.com", password: "nope-nope" });
    expect((await c.post("/v1/auth/login", { email: "reset-count@example.com", password: "password123" })).status).toBe(200);
    for (let i = 0; i < 4; i++) await c.post("/v1/auth/login", { email: "reset-count@example.com", password: "nope-nope" });
    expect((await c.post("/v1/auth/login", { email: "reset-count@example.com", password: "password123" })).status).toBe(200);
  });
});

describe("password reset", () => {
  it("answers 202 for unknown emails and sends nothing", async () => {
    const r = await c.post("/v1/auth/forgot-password", { email: "nobody@example.com" });
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ accepted: true });
    expect(mail.sent).toHaveLength(0);
  });

  it("emails a single-use link; resetting changes the password, signs out every session and verifies the email", async () => {
    const u = await registerUser(c, "forgot@example.com");
    expect(u.user.emailVerified).toBe(false);
    expect((await c.post("/v1/auth/forgot-password", { email: "Forgot@Example.com " })).status).toBe(202);
    const m = lastMailTo("forgot@example.com");
    expect(m.subject).toMatch(/Reset/);
    expect(m.html).toContain("/reset-password?token=");
    const token = linkToken(m.text, "/reset-password");

    expect((await c.post("/v1/auth/reset-password", { token, password: "brand-new-pass" })).status).toBe(204);
    expect((await c.post("/v1/auth/login", { email: "forgot@example.com", password: "password123" })).status).toBe(401);
    const login = await c.post("/v1/auth/login", { email: "forgot@example.com", password: "brand-new-pass" });
    expect(login.status).toBe(200);
    expect(login.body.data.user.emailVerified).toBe(true);
    expect((await c.post("/v1/auth/refresh", { refreshToken: u.refresh })).status).toBe(401); // old session is gone
    const again = await c.post("/v1/auth/reset-password", { token, password: "another-pass-1" });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_token");
  });

  it("rejects made-up tokens and weak passwords", async () => {
    expect((await c.post("/v1/auth/reset-password", { token: "x".repeat(40), password: "long-enough-pw" })).body.error.code).toBe("invalid_token");
    expect((await c.post("/v1/auth/reset-password", { token: "x".repeat(40), password: "short" })).status).toBe(400);
  });

  it("sends at most one reset email per minute per account", async () => {
    await registerUser(c, "spam@example.com");
    await c.post("/v1/auth/forgot-password", { email: "spam@example.com" });
    await c.post("/v1/auth/forgot-password", { email: "spam@example.com" });
    expect(mail.sent.filter((m) => m.to === "spam@example.com" && /Reset/.test(m.subject))).toHaveLength(1);
  });

  it("a reset lifts a sign-in lockout", async () => {
    await registerUser(c, "locked@example.com");
    for (let i = 0; i < 5; i++) await c.post("/v1/auth/login", { email: "locked@example.com", password: "bad-bad-bad" });
    await c.post("/v1/auth/forgot-password", { email: "locked@example.com" });
    await c.post("/v1/auth/reset-password", { token: linkToken(lastMailTo("locked@example.com").text, "/reset-password"), password: "fresh-password" });
    expect((await c.post("/v1/auth/login", { email: "locked@example.com", password: "fresh-password" })).status).toBe(200);
  });
});

describe("email verification", () => {
  it("registration sends a link that verifies the address once", async () => {
    const u = await registerUser(c, "verify@example.com");
    const m = lastMailTo("verify@example.com");
    expect(m.subject).toMatch(/Confirm/);
    const token = linkToken(m.text, "/verify-email");
    expect((await c.post("/v1/auth/verify-email", { token })).body.data).toEqual({ verified: true });
    expect((await c.get("/v1/me", u.token)).body.data.emailVerified).toBe(true);
    expect((await c.post("/v1/auth/verify-email", { token })).status).toBe(400);
  });

  it("resend is cooled down, and a no-op once verified", async () => {
    const u = await registerUser(c, "resend@example.com");
    const tooSoon = await c.post("/v1/me/resend-verification", {}, u.token);
    expect(tooSoon.status).toBe(429); // the registration email was sent seconds ago
    expect(tooSoon.body.error.code).toBe("too_soon");
    await c.post("/v1/auth/verify-email", { token: linkToken(lastMailTo("resend@example.com").text, "/verify-email") });
    const n = mail.sent.length;
    expect((await c.post("/v1/me/resend-verification", {}, u.token)).status).toBe(202);
    expect(mail.sent.length).toBe(n);
  });
});

describe("change password", () => {
  it("needs the current password, then signs other sessions out", async () => {
    const u = await registerUser(c, "change@example.com");
    expect((await c.post("/v1/me/password", { currentPassword: "wrong", newPassword: "new-password-1" }, u.token)).status).toBe(403);
    expect((await c.post("/v1/me/password", { currentPassword: "password123", newPassword: "password123" }, u.token)).body.error.code).toBe("same_password");
    expect((await c.post("/v1/me/password", { currentPassword: "password123", newPassword: "new-password-1" }, u.token)).status).toBe(204);
    expect((await c.post("/v1/auth/refresh", { refreshToken: u.refresh })).status).toBe(401);
    expect((await c.post("/v1/auth/login", { email: "change@example.com", password: "new-password-1" })).status).toBe(200);
  });
});
