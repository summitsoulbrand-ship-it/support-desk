import { defineConfig } from 'vitest/config';
import path from 'path';

// Unit-test runner for pure logic (no DB / network). Mirrors the `@/` path
// alias from tsconfig so tests import modules the same way the app does.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
