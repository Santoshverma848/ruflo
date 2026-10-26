import { afterEach, describe, it, expect } from 'vitest';
import { CacheManager } from './cache-manager.js';

// Discriminating regression tests for the redundant-estimateSize() fix.
//
// `estimateSize()` calls `JSON.stringify(data)` on the cache entry's data.
// Before the fix, every overwrite, delete, and LRU eviction re-stringified
// the value being removed/replaced just to recompute a size that had
// already been computed (and discarded) when that value was written.
// These tests count real `JSON.stringify` invocations (via a `toJSON()`
// hook on the cached value) to prove the old value is never re-serialized
// once it has already been written.

const caches: CacheManager<unknown>[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.shutdown();
});

function create(config: { maxSize?: number; maxMemory?: number } = {}): CacheManager<unknown> {
  const cache = new CacheManager<unknown>(config);
  caches.push(cache);
  return cache;
}

/** A value whose `toJSON()` increments a shared counter every time it is stringified. */
function countingValue(counter: { n: number }) {
  return {
    toJSON() {
      counter.n++;
      return { tag: 'v' };
    },
  };
}

describe('CacheManager estimateSize() is not redundantly re-invoked', () => {
  it('does not re-stringify the old value on overwrite', () => {
    const oldCounter = { n: 0 };
    const newCounter = { n: 0 };
    const cache = create();

    cache.set('a', countingValue(oldCounter));
    expect(oldCounter.n).toBe(1); // one stringify for the initial write

    cache.set('a', countingValue(newCounter)); // overwrite
    expect(oldCounter.n).toBe(1); // the OLD value must not be re-stringified
    expect(newCounter.n).toBe(1); // the NEW value is stringified exactly once
  });

  it('does not re-stringify the value on delete', () => {
    const counter = { n: 0 };
    const cache = create();

    cache.set('a', countingValue(counter));
    expect(counter.n).toBe(1);

    cache.delete('a');
    expect(counter.n).toBe(1);
  });

  it('does not re-stringify the evicted value on LRU capacity eviction', () => {
    const evictedCounter = { n: 0 };
    const newCounter = { n: 0 };
    const cache = create({ maxSize: 1 });

    cache.set('a', countingValue(evictedCounter));
    expect(evictedCounter.n).toBe(1);

    cache.set('b', countingValue(newCounter)); // evicts 'a' to stay at maxSize
    expect(cache.has('a')).toBe(false);
    expect(evictedCounter.n).toBe(1); // evicted value never re-stringified
    expect(newCounter.n).toBe(1);
  });

  it('does not re-stringify a value evicted to satisfy a memory-pressure write by a new key', () => {
    const evictedCounter = { n: 0 };
    const newCounter = { n: 0 };
    // Budget sized to hold exactly one ~16-byte entry (JSON.stringify({tag:'v'}).length*2 == 26).
    const cache = create({ maxMemory: 30 });

    cache.set('a', countingValue(evictedCounter));
    expect(evictedCounter.n).toBe(1);

    cache.set('b', countingValue(newCounter)); // 'a' must be evicted for budget
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(evictedCounter.n).toBe(1);
    expect(newCounter.n).toBe(1);
  });

  it('does not re-stringify a value evicted to satisfy a memory-pressure overwrite', () => {
    // countingValue()'s toJSON() returns {tag:'v'} -> JSON.stringify length 11 -> size 22.
    // A budget of 50 holds two such entries (44) with 6 bytes to spare, but not
    // one of them plus a grown replacement of size 30 (52 > 50) — forcing the
    // overwrite's own internal eviction loop to evict the other entry.
    const evictedCounter = { n: 0 };
    const keptCounter = { n: 0 };
    const growingCounter = { n: 0 };
    const cache = create({ maxMemory: 50 });

    cache.set('kept', countingValue(keptCounter));
    cache.set('evict-me', countingValue(evictedCounter));
    expect(keptCounter.n).toBe(1);
    expect(evictedCounter.n).toBe(1);

    // Overwriting 'kept' with a larger (but individually-fits-the-budget)
    // value must evict 'evict-me' for budget — without re-stringifying
    // evict-me's already-known size.
    cache.set('kept', {
      toJSON() {
        growingCounter.n++;
        return 'x'.repeat(13); // JSON.stringify length 15 -> size 30
      },
    });
    expect(cache.has('evict-me')).toBe(false);
    expect(cache.has('kept')).toBe(true);
    expect(evictedCounter.n).toBe(1);
    expect(growingCounter.n).toBe(1);
  });

  it('getStats().memoryUsage stays correct across set/overwrite/delete (invariant preserved)', () => {
    const cache = create();
    cache.set('a', 'small');
    cache.set('a', 'a larger replacement');
    expect(cache.getStats().memoryUsage).toBe(
      JSON.stringify('a larger replacement').length * 2,
    );
    cache.set('a', 'x');
    expect(cache.getStats().memoryUsage).toBe(6);
    cache.delete('a');
    expect(cache.getStats().memoryUsage).toBe(0);
  });
});
