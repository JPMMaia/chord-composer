import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The point of the sample cache is that samples survive a reload, which only a real
 * browser can demonstrate. What is testable here is the wiring either side of that:
 * that one storage is shared by every instrument, that a browser without Cache
 * Storage still gets a working (uncached) load rather than a crash, and that the
 * bucket the app clears is the bucket it writes to.
 */

const cacheStorageCtor = vi.fn(function (this: Record<string, unknown>, name?: string) {
  this.name = name;
});

vi.mock('smplr', () => ({ CacheStorage: cacheStorageCtor }));

const deleteCache = vi.fn(async () => true);

beforeEach(() => {
  vi.resetModules();
  cacheStorageCtor.mockClear();
  deleteCache.mockClear();
  vi.stubGlobal('caches', { delete: deleteCache });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadModule() {
  return import('@/engine/sampleCache');
}

describe('sampleStorage', () => {
  it('backs sample fetches with a named cache bucket', async () => {
    const { sampleStorage } = await loadModule();

    expect(sampleStorage()).toBeDefined();
    expect(cacheStorageCtor).toHaveBeenCalledTimes(1);
    expect(cacheStorageCtor.mock.calls[0][0]).toMatch(/chord-composer/);
  });

  it('hands every instrument the same store, so shared samples are fetched once', async () => {
    const { sampleStorage } = await loadModule();

    expect(sampleStorage()).toBe(sampleStorage());
    expect(cacheStorageCtor).toHaveBeenCalledTimes(1);
  });

  it('falls back to no storage where Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    const { sampleStorage } = await loadModule();

    expect(sampleStorage()).toBeUndefined();
    expect(cacheStorageCtor).not.toHaveBeenCalled();
  });

  it('falls back to no storage when opening the cache throws', async () => {
    cacheStorageCtor.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    const { sampleStorage } = await loadModule();

    expect(sampleStorage()).toBeUndefined();
  });
});

describe('clearSampleCache', () => {
  it('deletes the bucket the samples were written to', async () => {
    const { sampleStorage, clearSampleCache } = await loadModule();
    sampleStorage();

    await expect(clearSampleCache()).resolves.toBe(true);
    expect(deleteCache).toHaveBeenCalledWith(cacheStorageCtor.mock.calls[0][0]);
  });

  it('reports nothing cleared where Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    const { clearSampleCache } = await loadModule();

    await expect(clearSampleCache()).resolves.toBe(false);
  });
});
