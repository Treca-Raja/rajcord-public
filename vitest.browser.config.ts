import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('apps/api/.env')) loadEnvFile('apps/api/.env');

export default defineConfig({
  test: {
    include: [
      'apps/web/src/call-provider.integration.test.ts',
      'apps/api/src/auth/cookie-race.browser.integration.test.ts',
      'apps/web/src/screen-peer.browser.integration.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
