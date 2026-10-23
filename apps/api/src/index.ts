import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const { app } = createApp({
  logger: true,
  databaseUrl: process.env.DATABASE_URL,
  allowedOrigins: (
    process.env.WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001'
  ).split(','),
  secureCookies: process.env.NODE_ENV === 'production',
  staticRoot: existsSync(root) ? root : undefined,
});
try {
  await app.listen({
    port: Number(process.env.PORT || 3001),
    host: process.env.HOST || '127.0.0.1',
  });
} catch {
  app.log.error('API startup failed. Check database and port configuration.');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
