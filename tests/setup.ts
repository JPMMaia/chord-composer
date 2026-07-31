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
