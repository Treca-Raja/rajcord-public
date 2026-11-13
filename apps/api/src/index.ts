import { voiceConfig } from './voice/config.js';
import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { parseTrustProxyHops } from './proxy-config.js';
import { gifSearchConfig } from './chat/gif-search.js';
const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const { app } = createApp({
  logger: true,
  gifSearch: { config: gifSearchConfig(process.env) },
  voiceConfig: voiceConfig(),
  databaseUrl: process.env.DATABASE_URL,
  allowedOrigins: (
    process.env.WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001'
  ).split(','),
  secureCookies: process.env.NODE_ENV === 'production',
  trustProxyHops: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS),
  trustedProxyAddress: process.env.TRUST_PROXY_ADDRESS,
  staticRoot: existsSync(root) ? root : undefined,
});
try {
  await app.listen({
    port: Number(process.env.PORT || 3001),
    host: process.env.HOST || '127.0.0.1',
  });
} catch (error) {
  const code = (error as { code?: string }).code;
  app.log.error(
    { code: code ?? 'startup' },
    code === 'EADDRINUSE'
      ? 'API port is already in use. Close the other Rajcord development terminal and retry.'
      : 'API startup failed. Check local configuration.',
  );
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
