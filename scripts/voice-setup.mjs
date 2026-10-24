import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = new URL('../infrastructure/.env.voice', import.meta.url);
if (existsSync(path)) console.log('Existing voice configuration preserved.');
else {
  writeFileSync(
    path,
    'LIVEKIT_URL=http://127.0.0.1:7880\nLIVEKIT_API_KEY=tricord-local\nLIVEKIT_API_SECRET=' +
      randomBytes(32).toString('hex') +
      '\n',
    { flag: 'wx' },
  );
  console.log('Created ignored local voice credentials; no secrets printed.');
}
