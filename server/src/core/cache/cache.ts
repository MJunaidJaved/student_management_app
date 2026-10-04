/**
 * Caching, behind an interface (Part 5.10, decision 2).
 *
 * In-process for now. The interface exists because the implementation has to
 * change before a second server instance runs: an in-process cache means each
 * instance has its own copy, so invalidating a role's permissions on instance A
 * leaves instance B serving the old set until its TTL expires. That is a
 * privilege bug, not a staleness annoyance, which is why it is called out here
 * and in the README rather than left to be discovered.
 *
 * Keys are namespaced by a `CacheNamespace` so invalidation can be reasoned
 * about: clearing a user's permissions must not depend on remembering the exact
 * string used when it was written.
 */

import { LRUCache } from 'lru-cache';

/**
 * Every namespace the application caches under, with its TTL.
 *
 * Declared centrally so the answer to "how stale can this be" is in one place.
 * The permission TTL is deliberately short: it is the window in which a revoked
 * role still works.
 */
export const CACHE_TTL_MS = {
  /** Effective permission codes per user. Short: bounds privilege staleness. */
  'user-permissions': 60_000,
  /** Permission codes per role. Invalidated explicitly on role edits. */
  'role-permissions': 5 * 60_000,
  /** Settings key/value. Invalidated explicitly on write. */
  settings: 5 * 60_000,
  /** The current academic year; read by almost every request. */
  'current-academic-year': 5 * 60_000,
  /** Reference data: classes, sections, subjects, grading scales, fee categories. */
  reference: 10 * 60_000,
  /** A teacher's assigned sections and subjects; drives the policy layer. */
  'teacher-scope': 2 * 60_000,
} as const;

export type CacheNamespace = keyof typeof CACHE_TTL_MS;

export interface CacheStore {
  get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined>;
  set<T>(namespace: CacheNamespace, key: string, value: T): Promise<void>;
  delete(namespace: CacheNamespace, key: string): Promise<void>;
  /** Drop an entire namespace. Used when a change invalidates every entry. */
  clearNamespace(namespace: CacheNamespace): Promise<void>;
  /**
   * Read through: return the cached value, or compute, store and return it.
   *
   * The common shape, and worth having on the interface rather than written
   * out at each call site — a hand-rolled get/compute/set is where someone
   * eventually forgets the set.
   */
  getOrLoad<T>(namespace: CacheNamespace, key: string, load: () => Promise<T>): Promise<T>;
}

/**
 * In-process LRU with a per-namespace TTL.
 *
 * One LRU per namespace rather than a single shared one: a shared cache would
 * let a flood of settings reads evict every cached permission set, and the
 * eviction pressure of one namespace should not degrade another.
 */
export class InProcessCacheStore implements CacheStore {
  /*
   * Values are boxed in `{ v }` for two reasons. lru-cache requires a
   * non-nullable value type, and boxing means a legitimately-cached `null` or
   * `false` is still distinguishable from a miss — an unboxed `false` read back
   * as a falsy value is a classic source of a cache that never hits.
   */
  private readonly caches = new Map<CacheNamespace, LRUCache<string, Box>>();

  /** `max` is per namespace. 5,000 users' permission sets is a few MB at most. */
  constructor(private readonly max = 5_000) {}

  private cacheFor(namespace: CacheNamespace): LRUCache<string, Box> {
    let cache = this.caches.get(namespace);
    if (!cache) {
      cache = new LRUCache<string, Box>({
        max: this.max,
        ttl: CACHE_TTL_MS[namespace],
        // Without this, reading a value keeps it alive indefinitely, so a
        // frequently-read permission set would never pick up a role change.
        updateAgeOnGet: false,
      });
      this.caches.set(namespace, cache);
    }
    return cache;
  }

  async get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined> {
    const box = this.cacheFor(namespace).get(key);
    return box === undefined ? undefined : (box.v as T);
  }

  async set<T>(namespace: CacheNamespace, key: string, value: T): Promise<void> {
    this.cacheFor(namespace).set(key, { v: value });
  }

  async delete(namespace: CacheNamespace, key: string): Promise<void> {
    this.cacheFor(namespace).delete(key);
  }

  async clearNamespace(namespace: CacheNamespace): Promise<void> {
    this.cacheFor(namespace).clear();
  }

  async getOrLoad<T>(namespace: CacheNamespace, key: string, load: () => Promise<T>): Promise<T> {
    const box = this.cacheFor(namespace).get(key);
    if (box !== undefined) return box.v as T;

    const value = await load();
    // `undefined` is how a miss is signalled, so it is never stored; doing so
    // would make every subsequent read re-load anyway.
    if (value !== undefined) await this.set(namespace, key, value);
    return value;
  }
}

/** Wrapper so `null` and `false` can be cached without reading as a miss. */
type Box = { v: unknown };

/**
 * A cache that never stores anything.
 *
 * Used in tests, where a cached permission set from one case leaking into the
 * next produces failures that look like authorization bugs.
 */
export class NullCacheStore implements CacheStore {
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async clearNamespace(): Promise<void> {}
  async getOrLoad<T>(_ns: CacheNamespace, _key: string, load: () => Promise<T>): Promise<T> {
    return load();
  }
}
