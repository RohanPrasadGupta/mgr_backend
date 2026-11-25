import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// ── TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) — what Google Authenticator, 1Password, Authy etc. use ──

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}
/** Accepts the current code and one step either side (clock drift). Returns the matching step, or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    const expected = Buffer.from(totpCode(secret, s)); const got = Buffer.from(code);
    if (timingSafeEqual(expected, got)) return s;
  }
  return null;
}
export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`MoneyMgr Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent("MoneyMgr Admin")}&algorithm=SHA1&digits=6&period=30`;

// ── secret-at-rest encryption (AES-256-GCM, key derived from ADMIN_SECRET) ──

const encKey = (adminSecret: string) => createHash("sha256").update(`totp-enc:${adminSecret}`).digest();
export function encrypt(plain: string, adminSecret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(adminSecret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
export function decrypt(enc: string, adminSecret: string): string {
  const [iv, tag, body] = enc.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", encKey(adminSecret), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
}

// ── admin tokens (own key + audience; a customer token can never verify here and vice versa) ──

const jwtKey = (adminSecret: string) => new TextEncoder().encode(createHash("sha256").update(`admin-jwt:${adminSecret}`).digest("hex"));
type Purpose = "access" | "mfa";
export async function signAdminToken(adminId: string, purpose: Purpose, adminSecret: string, ttlSec: number) {
  return new SignJWT({ p: purpose }).setProtectedHeader({ alg: "HS256" }).setAudience("moneymgr-admin").setSubject(adminId).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(jwtKey(adminSecret));
}
export async function verifyAdminToken(token: string, purpose: Purpose, adminSecret: string): Promise<string> {
  const { payload } = await jwtVerify(token, jwtKey(adminSecret), { algorithms: ["HS256"], audience: "moneymgr-admin" });
  if (payload.p !== purpose || !payload.sub) throw new Error("wrong token purpose");
  return payload.sub;
}
