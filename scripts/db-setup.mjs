import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const infra = fileURLToPath(new URL('../infrastructure/.env', import.meta.url));
const api = fileURLToPath(new URL('../apps/api/.env', import.meta.url));
if (existsSync(infra) || existsSync(api)) {
  if (existsSync(infra) && existsSync(api)) console.log('Existing environment files preserved.');
  else
    throw new Error(
      'Only one environment file exists. Align the two files manually; nothing was overwritten.',
    );
} else {
  const password = randomBytes(32).toString('hex');
  writeFileSync(infra, 'POSTGRES_PASSWORD=' + password + '\n', { flag: 'wx' });
  writeFileSync(
    api,
    'HOST=127.0.0.1\nPORT=3001\nWEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001\nDATABASE_URL=postgresql://tricord:' +
      password +
      '@127.0.0.1:5432/tricord\n',
    { flag: 'wx' },
  );
  console.log('Created ignored local environment files. Password was not printed.');
}
