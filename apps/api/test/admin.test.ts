import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db";
import { admins, auditLog, users } from "../src/db/schema";
import { base32Decode, base32Encode, decrypt, totpCode, verifyTotp } from "../src/modules/admin/crypto";
import { client, makeApp, registerUser, resetDb } from "./helpers";

let app: NestFastifyApplication;
let c: ReturnType<typeof client>;
let db: Db;
beforeAll(async () => { app = await makeApp(); c = client(app); db = app.get<Db>(DB); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(app); });

const PW = "correct horse battery";
const now = () => Math.floor(Date.now() / 30_000);
async function mkAdmin(email = "ops@example.com") {
  await db.insert(admins).values({ email, name: "Ops", passwordHash: await hash(PW) });
}
/** Full sign-in: password → (enrol) → code. Returns the session and the authenticator secret. */
async function signIn(email = "ops@example.com", secret?: string) {
  const step = (await c.post("/v1/admin/auth/login", { email, password: PW })).body.data;
  const s = secret ?? step.secret;
  // a different 30-second step for each sign-in in a test, so the replay guard doesn't trip
  const code = totpCode(s, now() + (signIns++ % 2 === 0 ? 0 : 1));
  const res = await c.post("/v1/admin/auth/mfa", { mfaToken: step.mfaToken, code });
  return { session: res.body.data, secret: s, status: res.status };
}
let signIns = 0;
const reason = { reason: "Support ticket #42" };

describe("TOTP", () => {
  it("matches RFC 6238 test vectors and accepts ±1 step only", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082"); // RFC 6238, T=59 → 94287082 (last 6 digits)
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
    const t = 1_700_000_000_000; const step = Math.floor(t / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), t)).toBeNull();
    expect(verifyTotp(secret, "12345", t)).toBeNull();
  });
});

describe("admin sign-in", () => {
  it("enrols 2FA on first sign-in, then needs a code every time; codes can't be replayed", async () => {
    await mkAdmin();
    const first = (await c.post("/v1/admin/auth/login", { email: "ops@example.com", password: PW })).body.data;
    expect(first.step).toBe("setup");
    expect(first.otpauthUrl).toMatch(/^otpauth:\/\/totp\/MoneyMgr%20Admin%3Aops%40example\.com\?secret=/);
    const [row] = await db.select().from(admins);
    expect(row!.totpSecretEnc).not.toContain(first.secret); // stored encrypted
    expect(decrypt(row!.totpSecretEnc!, `admin:test-secret-test-secret-test-secret-123`)).toBe(first.secret);
    expect((await c.post("/v1/admin/auth/mfa", { mfaToken: first.mfaToken, code: "000000" })).status).toBe(401);
    const code = totpCode(first.secret, now());
    const ok = await c.post("/v1/admin/auth/mfa", { mfaToken: first.mfaToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.admin).toMatchObject({ email: "ops@example.com" });
    // the same code again (replay) is refused
    expect((await c.post("/v1/admin/auth/mfa", { mfaToken: first.mfaToken, code })).status).toBe(401);
    // enrolled now: the next sign-in asks for a code, and reveals no secret
    const again = (await c.post("/v1/admin/auth/login", { email: "ops@example.com", password: PW })).body.data;
    expect(again).toEqual({ step: "mfa", mfaToken: expect.any(String) });
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => a.action).sort()).toEqual(["admin.2fa_enrolled", "admin.mfa_failed", "admin.mfa_failed"]);
  });

  it("refuses wrong passwords (same message as unknown emails), locks out after 5, and refreshes/ends sessions", async () => {
    const LOCK = "lock@example.com"; // its own admin: the lockout counter outlives the DB reset between tests
    await mkAdmin(LOCK);
    const wrong = await c.post("/v1/admin/auth/login", { email: LOCK, password: "nope" });
    const unknown = await c.post("/v1/admin/auth/login", { email: "who@example.com", password: "nope" });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const { session } = await signIn(LOCK);
    const r = await c.post("/v1/admin/auth/refresh", { refreshToken: session.refreshToken });
    expect(r.status).toBe(200);
    expect((await c.post("/v1/admin/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401); // rotated
    await c.post("/v1/admin/auth/logout", { refreshToken: r.body.data.refreshToken });
    expect((await c.post("/v1/admin/auth/refresh", { refreshToken: r.body.data.refreshToken })).status).toBe(401);
    for (let i = 0; i < 5; i++) await c.post("/v1/admin/auth/login", { email: LOCK, password: "nope" });
    expect((await c.post("/v1/admin/auth/login", { email: LOCK, password: PW })).status).toBe(429);
  });

  it("keeps customer and admin tokens apart", async () => {
    await mkAdmin();
    const { session } = await signIn();
    const user = await registerUser(c, "u@example.com");
    expect((await c.get("/v1/admin/stats", user.token)).status).toBe(401);
    expect((await c.get("/v1/me", session.accessToken)).status).toBe(401);
    expect((await c.get("/v1/admin/stats")).status).toBe(401);
    // a disabled admin is locked out immediately, even with a live token
    await db.update(admins).set({ disabledAt: new Date() });
    expect((await c.get("/v1/admin/me", session.accessToken)).status).toBe(401);
  });
});

describe("admin views and actions", () => {
  let token: string;
  beforeEach(async () => { await mkAdmin(); token = (await signIn()).session.accessToken; });

  it("overview stats and user list carry counts but no money", async () => {
    const a = await registerUser(c, "alice@example.com", { name: "Alice" });
    await registerUser(c, "bob@example.com", { name: "Bob" });
    const cash = (await c.get("/v1/accounts", a.token)).body.data[0].id;
    await c.post("/v1/transactions", { accountId: cash, kind: "expense", amountMinor: 12_345, occurredAt: new Date().toISOString() }, a.token);
    const s = (await c.get("/v1/admin/stats", token)).body.data;
    expect(s.users).toMatchObject({ total: 2, unverified: 2, suspended: 0, newLast7: 2, activeLast30: 2 });
    expect(s.totals).toMatchObject({ transactions: 1, accounts: 2 });
    expect(s.signupsByDay).toHaveLength(30);
    expect(s.signupsByDay.at(-1).count).toBe(2);
    const list = (await c.get("/v1/admin/users?q=ali", token)).body.data;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ email: "alice@example.com", transactionCount: 1, accountCount: 1, suspended: false });
    expect(JSON.stringify(list)).not.toContain("12345"); // no amounts in the overview
    const d = (await c.get(`/v1/admin/users/${a.user.id}`, token)).body.data;
    expect(d.counts).toMatchObject({ transactions: 1, accounts: 1, categories: expect.any(Number) });
    expect(d.sessions).toHaveLength(1);
    expect(d.support.open).toBe(false);
    expect(JSON.stringify(d)).not.toContain("12345");
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "user.view")))).toHaveLength(1);
  });

  it("suspension blocks sign-in, refresh and live tokens; reactivation restores access", async () => {
    const u = await registerUser(c, "s@example.com");
    expect((await c.post(`/v1/admin/users/${u.user.id}/suspend`, { reason: "no" }, token)).status).toBe(400); // reason too short
    const s = await c.post(`/v1/admin/users/${u.user.id}/suspend`, reason, token);
    expect(s.body.data).toMatchObject({ suspended: true, suspendedReason: "Support ticket #42" });
    expect((await c.get("/v1/me", u.token)).body.error.code).toBe("account_suspended");
    expect((await c.post("/v1/auth/refresh", { refreshToken: u.refresh })).status).toBe(401); // session revoked
    const login = await c.post("/v1/auth/login", { email: "s@example.com", password: "password123" });
    expect([login.status, login.body.error.code]).toEqual([403, "account_suspended"]);
    expect((await c.post("/v1/auth/login", { email: "s@example.com", password: "wrong-one" })).status).toBe(401); // no hint without the password
    expect((await c.get("/v1/admin/users?status=suspended", token)).body.data.total).toBe(1);
    await c.post(`/v1/admin/users/${u.user.id}/reactivate`, reason, token);
    const back = await c.post("/v1/auth/login", { email: "s@example.com", password: "password123" });
    expect(back.status).toBe(200);
    expect((await c.get("/v1/me", back.body.data.accessToken)).status).toBe(200);
  });

  it("signs a user out everywhere, resends and marks verification", async () => {
    const u = await registerUser(c, "v@example.com");
    await c.post("/v1/auth/login", { email: "v@example.com", password: "password123" });
    expect((await c.post(`/v1/admin/users/${u.user.id}/sign-out`, reason, token)).body.data).toEqual({ revokedSessions: 2 });
    expect((await c.post("/v1/auth/refresh", { refreshToken: u.refresh })).status).toBe(401);
    expect((await c.post(`/v1/admin/users/${u.user.id}/mark-verified`, reason, token)).body.data.emailVerified).toBe(true);
    expect((await c.post(`/v1/admin/users/${u.user.id}/resend-verification`, reason, token)).status).toBe(422); // already verified
  });

  it("shows a user's data only inside a support view, and audits every read", async () => {
    const u = await registerUser(c, "d@example.com");
    const cash = (await c.get("/v1/accounts", u.token)).body.data[0].id;
    await c.post("/v1/transactions", { accountId: cash, kind: "expense", amountMinor: 4_200, note: "groceries", occurredAt: new Date().toISOString() }, u.token);
    const denied = await c.get(`/v1/admin/users/${u.user.id}/data/transactions`, token);
    expect([denied.status, denied.body.error.code]).toEqual([403, "support_view_required"]);
    const open = await c.post(`/v1/admin/users/${u.user.id}/support`, { reason: "User reports a wrong balance" }, token);
    expect(open.status).toBe(201);
    const tx = (await c.get(`/v1/admin/users/${u.user.id}/data/transactions`, token)).body.data;
    expect(tx.items[0]).toMatchObject({ amountMinor: 4_200, note: "groceries", accountName: "Cash" });
    expect((await c.get(`/v1/admin/users/${u.user.id}/data/accounts`, token)).body.data.items[0]).toMatchObject({ balanceMinor: -4_200 });
    expect((await c.get(`/v1/admin/users/${u.user.id}/data/passwords`, token)).status).toBe(404);
    await c.del(`/v1/admin/users/${u.user.id}/support`, token);
    expect((await c.get(`/v1/admin/users/${u.user.id}/data/transactions`, token)).status).toBe(403);
    const log = (await c.get(`/v1/admin/audit?userId=${u.user.id}`, token)).body.data;
    expect(log.items.map((e: any) => e.action)).toEqual(["support.close", "support.read", "support.read", "support.open"]);
    expect(log.items.find((e: any) => e.action === "support.read").reason).toBe("User reports a wrong balance");
  });

  it("deletes a user only with the exact email, keeping the audit entry", async () => {
    const u = await registerUser(c, "gone@example.com");
    expect((await c.del(`/v1/admin/users/${u.user.id}`, token, { reason: "GDPR request", confirmEmail: "other@example.com" })).status).toBe(422);
    expect((await c.del(`/v1/admin/users/${u.user.id}`, token, { reason: "GDPR request", confirmEmail: "gone@example.com" })).status).toBe(204);
    expect(await db.select().from(users).where(eq(users.id, u.user.id))).toHaveLength(0);
    expect((await c.get(`/v1/admin/users/${u.user.id}`, token)).status).toBe(404);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "user.delete"));
    expect(entry).toMatchObject({ targetEmail: "gone@example.com", reason: "GDPR request", adminEmail: "ops@example.com" });
  });

  it("reports system health", async () => {
    const h = (await c.get("/v1/admin/health", token)).body.data;
    expect(h.checks.map((x: any) => x.name)).toEqual(["Database", "Redis", "Exchange rates", "Email", "Receipt storage"]);
    expect(h.checks[0].ok).toBe(true);
  });
});

describe("admin accounts (owners)", () => {
  /** Sign in with any password; returns the access token (and the authenticator secret for later sign-ins). */
  async function signInAs(email: string, password: string, secret?: string) {
    const step = (await c.post("/v1/admin/auth/login", { email, password })).body.data;
    const s = secret ?? step.secret;
    const res = await c.post("/v1/admin/auth/mfa", { mfaToken: step.mfaToken, code: totpCode(s, now() + (signIns++ % 2 === 0 ? 0 : 1)) });
    expect(res.status).toBe(200);
    return { token: res.body.data.accessToken as string, secret: s, admin: res.body.data.admin };
  }
  const mkOwner = async (email = "owner@example.com") => { await db.insert(admins).values({ email, name: "Owner", role: "owner", passwordHash: await hash(PW) }); return signInAs(email, PW); };

  it("an owner adds an admin with a one-time password, which must be replaced before anything else works", async () => {
    const owner = await mkOwner();
    expect(owner.admin).toMatchObject({ role: "owner", mustChangePassword: false });
    const created = await c.post("/v1/admin/admins", { email: "New@Example.com", name: "New Admin", role: "admin", reason: "Hired for support" }, owner.token);
    expect(created.status).toBe(201);
    const { admin, temporaryPassword } = created.body.data;
    expect(admin).toMatchObject({ email: "new@example.com", role: "admin", mustChangePassword: true, twoFactorEnabled: false });
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const [row] = await db.select().from(admins).where(eq(admins.email, "new@example.com"));
    expect(row!.passwordHash).not.toContain(temporaryPassword); // only the hash is stored
    expect((await c.post("/v1/admin/admins", { email: "new@example.com", name: "Again", reason: "dup" }, owner.token)).status).toBe(409);

    // the new admin signs in (enrols 2FA) but is held at "change your password"
    const fresh = await signInAs("new@example.com", temporaryPassword);
    expect(fresh.admin.mustChangePassword).toBe(true);
    expect((await c.get("/v1/admin/me", fresh.token)).status).toBe(200);
    const blocked = await c.get("/v1/admin/users", fresh.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("password_change_required");
    expect((await c.post("/v1/admin/me/password", { currentPassword: "wrong", newPassword: "a brand new password" }, fresh.token)).status).toBe(403);
    expect((await c.post("/v1/admin/me/password", { currentPassword: temporaryPassword, newPassword: "short" }, fresh.token)).status).toBe(400);
    expect((await c.post("/v1/admin/me/password", { currentPassword: temporaryPassword, newPassword: "a brand new password" }, fresh.token)).status).toBe(204);
    expect((await c.get("/v1/admin/users", fresh.token)).status).toBe(200);
    expect((await c.get("/v1/admin/me", fresh.token)).body.data.mustChangePassword).toBe(false);

    // a regular admin can't see or manage admins
    const denied = await c.get("/v1/admin/admins", fresh.token);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("owner_only");
    expect((await c.post("/v1/admin/admins", { email: "x@example.com", name: "X", reason: "nope" }, fresh.token)).status).toBe(403);

    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.created", "admin.password_changed"]));
  });

  it("disables, re-enables, resets 2FA and passwords, and changes roles — never on yourself", async () => {
    const owner = await mkOwner();
    const { admin, temporaryPassword } = (await c.post("/v1/admin/admins", { email: "b@example.com", name: "B", reason: "team" }, owner.token)).body.data;
    const b = await signInAs("b@example.com", temporaryPassword);

    const off = await c.post(`/v1/admin/admins/${admin.id}/disable`, reason, owner.token);
    expect(off.body.data.disabledAt).not.toBeNull();
    expect((await c.get("/v1/admin/me", b.token)).status).toBe(401); // live token stops at once
    expect((await c.post("/v1/admin/auth/login", { email: "b@example.com", password: temporaryPassword })).status).toBe(401);
    expect((await c.post(`/v1/admin/admins/${admin.id}/enable`, reason, owner.token)).body.data.disabledAt).toBeNull();

    expect((await c.post(`/v1/admin/admins/${admin.id}/reset-2fa`, reason, owner.token)).body.data.twoFactorEnabled).toBe(false);
    expect((await c.post("/v1/admin/auth/login", { email: "b@example.com", password: temporaryPassword })).body.data.step).toBe("setup");

    const reset = (await c.post(`/v1/admin/admins/${admin.id}/reset-password`, reason, owner.token)).body.data;
    expect(reset.temporaryPassword).not.toBe(temporaryPassword);
    expect(reset.admin.mustChangePassword).toBe(true);
    expect((await c.post("/v1/admin/auth/login", { email: "b@example.com", password: temporaryPassword })).status).toBe(401);
    expect((await c.post("/v1/admin/auth/login", { email: "b@example.com", password: reset.temporaryPassword })).status).toBe(200);

    // yourself: refused
    for (const path of ["disable", "reset-2fa", "reset-password"]) {
      const r = await c.post(`/v1/admin/admins/${owner.admin.id}/${path}`, reason, owner.token);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("own_account");
    }
    const self = await c.post(`/v1/admin/admins/${owner.admin.id}/role`, { role: "admin", reason: "step down" }, owner.token);
    expect(self.body.error.code).toBe("own_account"); // an owner can't demote themself (so the last owner can't vanish)
    expect((await c.post(`/v1/admin/admins/${admin.id}/role`, { role: "owner", reason: "co-owner" }, owner.token)).body.data.role).toBe("owner");
    expect((await c.post(`/v1/admin/admins/${admin.id}/role`, { role: "admin", reason: "back to admin" }, owner.token)).body.data.role).toBe("admin");

    const list = (await c.get("/v1/admin/admins", owner.token)).body.data;
    expect(list.map((a: any) => a.email)).toEqual(["owner@example.com", "b@example.com"]);
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.disabled", "admin.enabled", "admin.2fa_reset", "admin.password_reset", "admin.role_changed"]));
  });

  it("a demoted owner loses the Admins page on their live session", async () => {
    const owner = await mkOwner();
    const { temporaryPassword } = (await c.post("/v1/admin/admins", { email: "c@example.com", name: "C", role: "owner", reason: "co-owner" }, owner.token)).body.data;
    const cOwner = await signInAs("c@example.com", temporaryPassword);
    await c.post("/v1/admin/me/password", { currentPassword: temporaryPassword, newPassword: "c's new long password" }, cOwner.token);
    expect((await c.post(`/v1/admin/admins/${owner.admin.id}/role`, { role: "admin", reason: "handover" }, cOwner.token)).status).toBe(200);
    expect((await c.get("/v1/admin/admins", owner.token)).status).toBe(403);
    expect((await c.get("/v1/admin/users", owner.token)).status).toBe(200); // support tools stay
  });
});
