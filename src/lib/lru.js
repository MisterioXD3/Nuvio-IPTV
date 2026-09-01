'use strict';

/**
 * Minimal LRU cache with per-entry TTL, backed by the insertion order of a Map.
 */
class LruCache {
  constructor({ max = 1000, ttlMs = 300000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    return value;
  }

  clear() {
    this.map.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}

module.exports = { LruCache };
