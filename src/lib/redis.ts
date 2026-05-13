import Redis from "ioredis";

const g = globalThis as unknown as { __airdropRedis?: Redis | null };

function redisUrl(): string | null {
  const u = process.env.REDIS_URL?.trim();
  return u || null;
}

/**
 * Singleton Redis client. Returns `null` when `REDIS_URL` is unset or Redis is unreachable.
 * Uses lazy connect; failures are swallowed so the app keeps running without Redis.
 */
export function getRedis(): Redis | null {
  if (g.__airdropRedis !== undefined) return g.__airdropRedis;

  const url = redisUrl();
  if (!url) {
    g.__airdropRedis = null;
    return null;
  }

  try {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 4) return null;
        return Math.min(times * 200, 2000);
      },
    });
    client.on("error", () => {
      /* logged once; callers use try/catch */
    });
    g.__airdropRedis = client;
    return client;
  } catch {
    g.__airdropRedis = null;
    return null;
  }
}

export async function safeRedisGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    if (r.status !== "ready") await r.connect().catch(() => {});
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function safeRedisSetex(key: string, ttlSec: number, value: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (r.status !== "ready") await r.connect().catch(() => {});
    await r.setex(key, ttlSec, value);
  } catch {
    /* ignore */
  }
}

export async function safeRedisDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (r.status !== "ready") await r.connect().catch(() => {});
    await r.del(key);
  } catch {
    /* ignore */
  }
}

/** Atomic INCR under max with TTL on first increment. Returns true if slot acquired. */
export async function safeRedisIncrUnderLimit(key: string, max: number, ttlSec: number): Promise<boolean | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    if (r.status !== "ready") await r.connect().catch(() => {});
    const script = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1`;
    const v = (await r.eval(script, 1, key, String(max), String(ttlSec))) as number;
    return v === 1;
  } catch {
    return null;
  }
}

export async function safeRedisDecr(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (r.status !== "ready") await r.connect().catch(() => {});
    await r.decr(key).catch(() => {});
  } catch {
    /* ignore */
  }
}
