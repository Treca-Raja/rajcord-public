import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
const command = (script: string) => 'node -e "' + script + '"';
async function lifecycle(desktop: string, api = 'setInterval(()=>{},1000)') {
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/concurrently/dist/bin/concurrently.js'),
      '-k',
      '--success',
      'command-desktop',
      '-n',
      'api,web,desktop',
      command(api),
      command('setInterval(()=>{},1000)'),
      command(desktop),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}
it('normal desktop exit stops helpers and reports success', async () => {
  const result = await lifecycle('setTimeout(()=>process.exit(0),500)');
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('exited with code 0');
}, 15000);
it('desktop failure remains a failure', async () => {
  const result = await lifecycle('setTimeout(()=>process.exit(7),500)');
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('exited with code 7');
}, 15000);
it('unexpected API failure stops the desktop and remains a failure', async () => {
  const result = await lifecycle('setInterval(()=>{},1000)', 'setTimeout(()=>process.exit(9),500)');
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('exited with code 9');
}, 15000);
