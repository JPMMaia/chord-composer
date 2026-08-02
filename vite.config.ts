/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // Rust sources are rebuilt by cargo, not Vite; watching them would restart
    // the dev server on every `cargo` write.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Tauri prints Rust compile errors to the same terminal. Clearing it eats them.
  clearScreen: false,
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
  },
} as import('vite').UserConfig & { test?: Record<string, unknown> })
