/**
 * Tiny key-value store: Upstash Redis on Vercel (Marketplace integration), in-memory for local dev.
 */
import { Redis } from "@upstash/redis";

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>;
  del(key: string): Promise<void>;
  /** Set only if absent (for locks). Returns true if set. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  readonly persistent: boolean;
}

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

class RedisStore implements Store {
  readonly persistent = true;
  constructor(private redis: Redis) {}
  async get<T>(key: string) {
    return (await this.redis.get<T>(key)) ?? null;
  }
  async set(key: string, value: unknown, opts?: { ttlSeconds?: number }) {
    if (opts?.ttlSeconds) await this.redis.set(key, value, { ex: opts.ttlSeconds });
    else await this.redis.set(key, value);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
  async setNx(key: string, value: string, ttlMs: number) {
    return (await this.redis.set(key, value, { nx: true, px: ttlMs })) === "OK";
  }
}

class MemoryStore implements Store {
  readonly persistent = false;
  private data = new Map<string, { value: unknown; expires?: number }>();
  private live(key: string) {
    const e = this.data.get(key);
    if (e?.expires && e.expires < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async get<T>(key: string) {
    return (this.live(key)?.value as T) ?? null;
  }
  async set(key: string, value: unknown, opts?: { ttlSeconds?: number }) {
    this.data.set(key, { value: structuredClone(value), expires: opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : undefined });
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async setNx(key: string, value: string, ttlMs: number) {
    if (this.live(key)) return false;
    this.data.set(key, { value, expires: Date.now() + ttlMs });
    return true;
  }
}

let store: Store | undefined;

export function getStore(): Store {
  if (store) return store;
  const url = env("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN");
  if (url && token) {
    store = new RedisStore(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL) {
      console.warn("[store] No Upstash Redis env vars found; using in-memory store (sign-in will not persist).");
    }
    store = new MemoryStore();
  }
  return store;
}
