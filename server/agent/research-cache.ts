interface CacheEntry<T> { value: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const TTL = Number(process.env.RESEARCH_CACHE_TTL_MS || 120000);

function key(fixture: string, field: string, source = 'any', date = ''): string {
  return `${fixture.toLowerCase().replace(/\s+/g, ' ').trim()}|${field.toLowerCase()}|${source.toLowerCase()}|${date}`;
}

export function getResearch<T>(fixture: string, field: string, source?: string, date?: string): T | undefined {
  const k = key(fixture, field, source, date);
  const hit = cache.get(k);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) { cache.delete(k); return undefined; }
  return hit.value as T;
}

export function setResearch<T>(fixture: string, field: string, value: T, source?: string, date?: string, ttl = TTL): void {
  cache.set(key(fixture, field, source, date), { value, expiresAt: Date.now() + ttl });
}

export async function memoResearch<T>(fixture: string, field: string, producer: () => Promise<T>, source = 'any', date = ''): Promise<T> {
  const cached = getResearch<T>(fixture, field, source, date);
  if (cached !== undefined) return cached;
  const k = key(fixture, field, source, date);
  const existing = inflight.get(k) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = producer().then(value => { setResearch(fixture, field, value, source, date); return value; }).finally(() => inflight.delete(k));
  inflight.set(k, promise);
  return promise;
}

export function researchCacheStats() {
  let active = 0;
  for (const entry of cache.values()) if (entry.expiresAt > Date.now()) active++;
  return { entries: active, inflight: inflight.size, ttlMs: TTL };
}
