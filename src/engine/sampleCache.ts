import { CacheStorage, type Storage } from 'smplr';

/**
 * Persistent local storage for instrument samples.
 *
 * Without this, every sampler fetches its notes from smplr's CDN through plain
 * `fetch`. The HTTP cache makes that cheap *within* a session, but it is evicted
 * freely, so re-opening the app routinely re-downloads several megabytes before
 * the first note sounds. smplr's `CacheStorage` puts the same responses in a named
 * Cache Storage bucket instead, which survives reloads and browser restarts and is
 * only cleared when the user clears site data.
 *
 * One instance is shared by every instrument: the bucket is keyed by sample URL, so
 * two instruments that use the same note file — and the piano's own layers across a
 * rebuild — hit the cache rather than the network.
 */

/** Bucket name. Versioned so a future change of sample source can orphan the old set. */
const CACHE_NAME = 'chord-composer-samples-v1';

let cached: Storage | undefined;
let resolved = false;

/**
 * The shared sample store, or `undefined` where Cache Storage is unavailable —
 * insecure origins, some private-browsing modes, and non-browser environments.
 * `undefined` means "no `storage` option", which leaves smplr on plain `fetch`:
 * slower on the next visit, but never a failure to load.
 */
export function sampleStorage(): Storage | undefined {
  if (resolved) return cached;
  resolved = true;

  if (typeof caches === 'undefined') return undefined;

  try {
    cached = new CacheStorage(CACHE_NAME);
  } catch {
    cached = undefined;
  }

  return cached;
}

/**
 * Drop every cached sample, so the next load re-fetches from the CDN.
 *
 * Resolves `false` if there was no bucket to delete. Nothing in the app calls this
 * during normal use — it exists so a stale or corrupt cache can be recovered from
 * without clearing all of the site's data, which would also take the user's projects.
 */
export async function clearSampleCache(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  return caches.delete(CACHE_NAME);
}
