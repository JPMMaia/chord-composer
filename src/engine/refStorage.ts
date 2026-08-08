/**
 * Remembering which file the app had open, across reloads and restarts.
 *
 * IndexedDB rather than localStorage because of what is being stored: in the browser
 * a reference holds a live `FileSystemFileHandle`, which is an object the browser
 * owns and will only round-trip through structured clone. It cannot be turned into a
 * string, so the one store that keeps objects is the only place it can go. Desktop
 * path references ride along in the same record for the sake of one code path.
 *
 * A restored handle carries no *permission* — that has to be asked for again on the
 * next write, from a user gesture. See `ensureWritable` in `projectFile.ts`.
 *
 * Every operation swallows its failure and answers null. There are real environments
 * without IndexedDB — private windows, the jsdom the tests run in — and forgetting
 * which file was open is a small enough loss that it must never stop the app loading.
 */
import type { ProjectFileRef } from '@/engine/projectFile';

const DB_NAME = 'chord-composer';
const STORE_NAME = 'files';
const CURRENT_KEY = 'current';

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Store or clear the reference to remember.
 *
 * A `download` reference is dropped rather than stored: it names a file that left
 * through the Downloads folder and can never be written again, so remembering it
 * would only make the UI claim a file it cannot save to.
 */
export async function storeCurrentRef(ref: ProjectFileRef | null): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    const keep = ref && ref.kind !== 'download' ? ref : null;
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    if (keep) store.put(keep, CURRENT_KEY);
    else store.delete(CURRENT_KEY);
    await new Promise<void>(resolve => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  } catch {
    // Storage may be unavailable or the handle unclonable; the file is still open.
  } finally {
    db.close();
  }
}

/** The remembered reference, or null when there is none or it cannot be read. */
export async function loadCurrentRef(): Promise<ProjectFileRef | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
    const request = store.get(CURRENT_KEY);
    const value = await new Promise<unknown>(resolve => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    return isRef(value) ? value : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Guard the stored record, which an older build may have written differently. */
function isRef(value: unknown): value is ProjectFileRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; path?: unknown; handle?: unknown };
  if (candidate.kind === 'path') return typeof candidate.path === 'string';
  if (candidate.kind === 'handle') return typeof candidate.handle === 'object' && candidate.handle !== null;
  return false;
}
