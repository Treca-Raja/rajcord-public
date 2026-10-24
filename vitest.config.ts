import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    testTimeout: 10000,
  },
});
