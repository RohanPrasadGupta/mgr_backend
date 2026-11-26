/**
 * Admin accounts are created and managed from the command line only (there is no admin sign-up page).
 *
 *   pnpm admin create --email you@example.com --name "Your Name"     # asks for a password (or reads ADMIN_PASSWORD); owner by default
 *   pnpm admin create --email b@example.com --role admin              # a regular admin (support tools, no Admins page)
 *   pnpm admin reset-2fa --email you@example.com                     # next sign-in enrols a new authenticator
 *   pnpm admin disable --email you@example.com / enable --email ...   # disabling also ends every admin session
 *   pnpm admin list
 */
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/db";
import { adminSessions, admins, auditLog } from "../src/db/schema";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

function askHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s) => { if (s.includes(q)) out.output.write(s); }; // don't echo the password
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

async function main() {
  const config = loadConfig();
  const { pool, db } = createDb(config.DATABASE_URL);
  const email = arg("email")?.trim().toLowerCase();
  const audit = (action: string) => db.insert(auditLog).values({ adminEmail: email ?? null, action, meta: { via: "cli" } });
  try {
    if (cmd === "list") {
      for (const a of await db.select().from(admins)) console.log(`${a.email}\t${a.name}\t${a.role}\t2FA: ${a.totpEnabledAt ? "on" : "not enrolled"}\t${a.disabledAt ? "DISABLED" : "active"}`);
      return;
    }
    if (!email) throw new Error("--email is required");
    if (cmd === "create") {
      const name = arg("name") ?? email.split("@")[0]!;
      const password = process.env.ADMIN_PASSWORD ?? (await askHidden("Password (min 12 characters): "));
      if (password.length < 12) throw new Error("Use at least 12 characters for an admin password");
      const role = (arg("role") ?? "owner") as "owner" | "admin";
      if (role !== "owner" && role !== "admin") throw new Error("--role must be owner or admin");
      await db.insert(admins).values({ email, name, role, passwordHash: await hash(password) });
      await audit("admin.created");
      console.log(`Created admin ${email}. Sign in at the admin site; you'll be asked to set up an authenticator app.`);
    } else if (cmd === "reset-2fa") {
      const r = await db.update(admins).set({ totpSecretEnc: null, totpEnabledAt: null }).where(eq(admins.email, email)).returning();
      if (!r.length) throw new Error(`No admin ${email}`);
      await audit("admin.2fa_reset");
      console.log(`2FA reset for ${email}: the next sign-in shows a new QR code.`);
    } else if (cmd === "disable" || cmd === "enable") {
      const r = await db.update(admins).set({ disabledAt: cmd === "disable" ? new Date() : null }).where(eq(admins.email, email)).returning();
      if (!r.length) throw new Error(`No admin ${email}`);
      if (cmd === "disable") await db.update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.adminId, r[0]!.id));
      await audit(cmd === "disable" ? "admin.disabled" : "admin.enabled");
      console.log(`${email} ${cmd}d.`);
    } else {
      throw new Error("Usage: pnpm admin <create|reset-2fa|disable|enable|list> --email you@example.com [--name \"Name\"]");
    }
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
