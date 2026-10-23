import { createApp } from './app.js';
const { app } = createApp({
  logger: true,
  databaseUrl: process.env.DATABASE_URL,
  allowedOrigins: (process.env.WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(
    ',',
  ),
});
const port = Number(process.env.PORT || 3001);
try {
  await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
