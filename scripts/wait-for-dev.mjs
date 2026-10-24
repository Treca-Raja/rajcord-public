import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function waitForDevelopment({
  webUrl = 'http://127.0.0.1:5173',
  apiUrl = 'http://127.0.0.1:3001/health',
  timeoutMs = 30000,
  intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let missing = ['web app', 'API'];
  let checked = false;
  while (!checked || Date.now() + 25 < deadline) {
    checked = true;
    const remaining = Math.max(1, deadline - Date.now());
    const checks = await Promise.all([
      fetch(webUrl, { signal: AbortSignal.timeout(Math.min(2000, remaining)) })
        .then(async (response) => {
          await response.body?.cancel();
          return response.ok;
        })
        .catch(() => false),
      fetch(apiUrl, { signal: AbortSignal.timeout(Math.min(2000, remaining)) })
        .then(async (response) => {
          if (!response.ok) {
            await response.body?.cancel();
            return false;
          }
          const body = await response.json();
          return body.status === 'ok' && body.service === 'tricord-api';
        })
        .catch(() => false),
    ]);
    missing = ['web app', 'API'].filter((_, index) => !checks[index]);
    if (!missing.length) return;
    if (Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
  throw new Error(
    'Desktop startup timed out waiting for: ' +
      missing.join(', ') +
      '. Check the [api] and [web] output above. Run pnpm --filter @tricord/api dev to diagnose API startup.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Waiting up to 30 seconds for the web app and Tricord API…');
  try {
    await waitForDevelopment();
    console.log('Web app and API are ready. Opening Electron…');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Development startup failed.');
    process.exitCode = 1;
  }
}
