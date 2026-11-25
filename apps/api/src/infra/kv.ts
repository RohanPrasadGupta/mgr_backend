import Redis from "ioredis";

/**
 * Small key/value surface for short-lived security state (lockout counters, one-time tokens).
 * Backed by Redis when REDIS_URL is set so it is shared by every API instance and survives restarts;
 * in-memory otherwise (local single instance and tests).
 */
export interface Kv {
  /** Increment a counter; the TTL is set when the key is created and never extended. Returns the new count. */
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Atomically read and delete (single-use tokens). */
  take(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<void>;
  /** Seconds until the key expires, or -2 when it doesn't exist. */
  ttl(key: string): Promise<number>;
  readonly kind: "redis" | "memory";
}

export const KV = Symbol("KV");
export const REDIS = Symbol("REDIS");
export const KEYS = Symbol("KEYS");

/** Every key the app writes, in one place. All start with the configured prefix (default `mm:`). */
export const keys = (prefix: string) => ({
  loginFailures: (email: string) => `${prefix}auth:login-fail:${email}`,
  deleteFailures: (userId: string) => `${prefix}auth:delete-fail:${userId}`,
  resetToken: (hash: string) => `${prefix}auth:reset:${hash}`,
  verifyToken: (hash: string) => `${prefix}auth:verify:${hash}`,
  mailCooldown: (kind: string, id: string) => `${prefix}auth:mail-cooldown:${kind}:${id}`,
  /** Set while a suspension may still have live access tokens (they're refused by the auth guard). */
  userSuspended: (userId: string) => `${prefix}auth:suspended:${userId}`,
  adminLoginFailures: (email: string) => `${prefix}admin:login-fail:${email}`,
  /** A 2FA code accepted for an admin can't be replayed within its validity window. */
  adminTotpUsed: (adminId: string, code: string) => `${prefix}admin:totp-used:${adminId}:${code}`,
  /** An admin's open support view of one user's data (expires on its own). */
  supportGrant: (adminId: string, userId: string) => `${prefix}admin:support:${adminId}:${userId}`,
  rateLimitNamespace: `${prefix}rl:`,
});
export type Keys = ReturnType<typeof keys>;

export class RedisKv implements Kv {
  readonly kind = "redis" as const;
  constructor(private readonly r: Redis) {}
  async incr(key: string, ttlSec: number) {
    const [[, n]] = (await this.r.multi().incr(key).expire(key, ttlSec, "NX").exec()) as [[null, number]];
    return n;
  }
  get(key: string) { return this.r.get(key); }
  async set(key: string, value: string, ttlSec: number) { await this.r.set(key, value, "EX", ttlSec); }
  take(key: string) { return this.r.getdel(key); }
  async del(...k: string[]) { if (k.length) await this.r.del(...k); }
  ttl(key: string) { return this.r.ttl(key); }
}

export class MemoryKv implements Kv {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, { v: string; exp: number }>();
  private live(key: string) {
    const e = this.m.get(key);
    if (e && e.exp <= Date.now()) { this.m.delete(key); return undefined; }
    return e;
  }
  async incr(key: string, ttlSec: number) {
    const e = this.live(key);
    const n = (e ? Number(e.v) : 0) + 1;
    this.m.set(key, { v: String(n), exp: e?.exp ?? Date.now() + ttlSec * 1000 });
    return n;
  }
  async get(key: string) { return this.live(key)?.v ?? null; }
  async set(key: string, v: string, ttlSec: number) { this.m.set(key, { v, exp: Date.now() + ttlSec * 1000 }); }
  async take(key: string) { const v = this.live(key)?.v ?? null; this.m.delete(key); return v; }
  async del(...k: string[]) { k.forEach((x) => this.m.delete(x)); }
  async ttl(key: string) { const e = this.live(key); return e ? Math.ceil((e.exp - Date.now()) / 1000) : -2; }
}

export function createRedis(url: string) {
  return new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: true, connectionName: "moneymgr-api" });
}
