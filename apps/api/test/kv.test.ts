import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryKv, RedisKv, keys, type Kv } from "../src/infra/kv";

const url = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null });
const reachable = await redis.connect().then(() => true, () => false);
afterAll(async () => { if (reachable) { const k = await redis.keys("mmtest:*"); if (k.length) await redis.del(...k); await redis.quit(); } else redis.disconnect(); });

const k = keys("mmtest:");
function contract(make: () => Kv) {
  it("incr counts and keeps the first TTL", async () => {
    const kv = make(); const key = `${k.loginFailures("a@x")}:${Math.random()}`;
    expect(await kv.incr(key, 60)).toBe(1);
    expect(await kv.incr(key, 999)).toBe(2);
    expect(await kv.ttl(key)).toBeLessThanOrEqual(60);
    expect(await kv.get(key)).toBe("2");
  });
  it("take is single-use; del and missing keys", async () => {
    const kv = make(); const key = `${k.resetToken("h")}:${Math.random()}`;
    await kv.set(key, "user-1", 60);
    expect(await kv.take(key)).toBe("user-1");
    expect(await kv.take(key)).toBeNull();
    await kv.set(key, "v", 60); await kv.del(key);
    expect(await kv.get(key)).toBeNull();
    expect(await kv.ttl(key)).toBe(-2);
  });
  it("expires", async () => {
    const kv = make(); const key = `${k.verifyToken("e")}:${Math.random()}`;
    await kv.set(key, "v", 1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await kv.get(key)).toBeNull();
  });
}

describe("key names", () => {
  it("every key starts with the configured prefix", () => {
    const all = [k.loginFailures("e"), k.deleteFailures("u"), k.resetToken("h"), k.verifyToken("h"), k.mailCooldown("verify", "u"), k.rateLimitNamespace];
    expect(all.every((x) => x.startsWith("mmtest:"))).toBe(true);
  });
});
describe("MemoryKv", () => contract(() => new MemoryKv()));
describe.runIf(reachable)("RedisKv (local Redis)", () => contract(() => new RedisKv(redis)));
