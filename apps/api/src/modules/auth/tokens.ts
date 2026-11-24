import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newRefreshToken = () => randomBytes(48).toString("base64url");

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(userId: string, secret: string, ttlSec: number) {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(key(secret));
}
export async function verifyAccessToken(token: string, secret: string): Promise<string> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
  if (!payload.sub) throw new Error("no subject");
  return payload.sub;
}
