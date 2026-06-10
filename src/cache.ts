// Vendored from products/_template/src/cache.ts. Keep these two files in sync.

export interface CachedValue<T> { v: T; exp: number; }

export class KvCache {
  constructor(private kv: KVNamespace, private prefix: string = "cache") {}

  async get<T>(key: string): Promise<T | null> {
    const wrapped = await this.kv.get<CachedValue<T>>(this.k(key), "json");
    if (!wrapped) return null;
    if (Date.now() > wrapped.exp) return null;
    return wrapped.v;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const jitterMs = Math.floor(Math.random() * 0.1 * ttlSeconds * 1000);
    const exp = Date.now() + ttlSeconds * 1000 + jitterMs;
    await this.kv.put(this.k(key), JSON.stringify({ v: value, exp }), {
      expirationTtl: Math.max(60, Math.floor(ttlSeconds * 1.5)),
    });
  }

  async memoize<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await fn();
    this.set(key, fresh, ttlSeconds).catch((e) => console.error("cache.set failed", e));
    return fresh;
  }

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }
}

export function stableKey(parts: object | string): string {
  if (typeof parts === "string") return parts;
  const sorted = Object.keys(parts).sort();
  return sorted.map((k) => `${k}=${JSON.stringify((parts as any)[k])}`).join("&");
}
