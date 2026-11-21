import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('apps/api/.env')) loadEnvFile('apps/api/.env');

export default defineConfig({
  test: {
    include: [
      'apps/web/src/shared/feature-boundary.browser.integration.test.ts',
      'apps/web/src/app/conversation-dialog.browser.integration.test.ts',
      'apps/web/src/features/account/password-recovery.browser.integration.test.ts',
      'apps/web/src/app/call-provider.integration.test.ts',
      'apps/web/src/features/chat/chat-polish.browser.integration.test.ts',
      'apps/api/src/auth/cookie-race.browser.integration.test.ts',
      'apps/web/src/features/screen-sharing/screen-peer.browser.integration.test.ts',
      'apps/web/src/features/screen-sharing/screen-call.browser.integration.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
