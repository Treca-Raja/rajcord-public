import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createDatabase } from '../db/client.js';
import { AuthService } from './service.js';
import { HttpError } from './validation.js';
async function hiddenPassword(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Run owner:bootstrap in an interactive terminal.');
  stdout.write('Password (12–128 characters): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', read);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const read = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 129) value += char;
      }
    };
    stdin.on('data', read);
  });
}
const db = createDatabase(process.env.DATABASE_URL ?? '');
try {
  if ((await db.pool.query('SELECT id FROM platform')).rowCount)
    throw new HttpError(409, 'Platform owner is already initialized. Nothing changed.');
  const rl = createInterface({ input: stdin, output: stdout });
  const name = await rl.question('New owner username: ');
  const display = await rl.question('Display name: ');
  rl.close();
  const secret = await hiddenPassword();
  const owner = await new AuthService(db.pool).bootstrap(name, display, secret);
  console.log('Owner created: ' + owner.username + '. Sign in through the application.');
} catch (error) {
  console.error(
    error instanceof HttpError
      ? error.message
      : 'Owner creation failed. Check inputs, database configuration, and whether the username already exists.',
  );
  process.exitCode = 1;
} finally {
  await db.pool.end();
}
