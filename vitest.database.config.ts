import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('apps/api/.env')) loadEnvFile('apps/api/.env');
export default defineConfig({
  test: {
    include: ['apps/api/src/**/*.integration.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
