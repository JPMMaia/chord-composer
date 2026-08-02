import { describe, it, expect, afterEach } from 'vitest';
import { isTauri } from '@/engine/platform';

/** Tauri injects this on `window` before any app code runs. */
const MARKER = '__TAURI_INTERNALS__';

function withMarker(): void {
  (window as unknown as Record<string, unknown>)[MARKER] = {};
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[MARKER];
});

describe('isTauri', () => {
  it('is false in a plain browser', () => {
    expect(isTauri()).toBe(false);
  });

  it('is true once the Tauri IPC bootstrap is present', () => {
    withMarker();
    expect(isTauri()).toBe(true);
  });

  // Read lazily rather than captured at import time, or the first test file to
  // import the module would freeze the answer for every later one.
  it('re-reads the marker on every call', () => {
    expect(isTauri()).toBe(false);
    withMarker();
    expect(isTauri()).toBe(true);
    delete (window as unknown as Record<string, unknown>)[MARKER];
    expect(isTauri()).toBe(false);
  });
});
