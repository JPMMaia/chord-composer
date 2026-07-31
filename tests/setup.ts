import '@testing-library/jest-dom/vitest'
import { expect } from 'vitest'

declare module 'vitest' {
  interface Matchers<T = unknown> {
    toBeString(): T;
  }
}

// jest-extended style matcher used across the engine tests
expect.extend({
  toBeString(received: unknown) {
    const pass = typeof received === 'string';
    return {
      pass,
      message: () =>
        pass
          ? `expected ${typeof received} not to be a string`
          : `expected ${typeof received} to be a string`,
    };
  },
});

// ResizeObserver is not available in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// This jsdom build ships sessionStorage but not localStorage, so the autosave code
// paths have nothing to talk to. Provide a minimal in-memory Storage implementation.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
      writable: true,
    });
  }
}
