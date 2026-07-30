import '@testing-library/jest-dom/vitest'

// ResizeObserver is not available in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
