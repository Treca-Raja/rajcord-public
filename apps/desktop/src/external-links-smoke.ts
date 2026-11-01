import { app, BrowserWindow, session } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWindowOpenHandler } from './external-links.js';

// Exercise Electron's real event with a recording OS adapter, without launching a browser.
const profile = path.resolve(__dirname, '../.local/external-links-smoke');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><title>Link smoke</title><body>Link smoke</body>');
});

async function run() {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const opened: string[] = [];
  const requests: string[] = [];
  const handler = await createWindowOpenHandler({
    target,
    currentUrl: () => win.webContents.getURL(),
    openExternal: async (url) => {
      opened.push(url);
    },
    onError: () => assert.fail('Unexpected external-launch failure'),
  });
  win.webContents.setWindowOpenHandler((details) => {
    requests.push(details.url);
    const result = handler(details);
    assert.equal(result.action, 'deny');
    return result;
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadURL(target);
  async function click(url: string) {
    await win.webContents.executeJavaScript(
      `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(url)};a.target='_blank';a.rel='noopener noreferrer';document.body.append(a);a.click();a.remove()})()`,
      true,
    );
  }
  await click('https://example.com/link-smoke');
  for (let attempt = 0; opened.length === 0 && attempt < 100; attempt++) await delay(50);
  assert.deepEqual(opened, ['https://example.com/link-smoke']);
  assert.ok(requests.includes('https://example.com/link-smoke'));
  for (const url of [
    'javascript:void(0)',
    'file:///not-a-real-link-smoke-file',
    'data:text/plain,smoke',
    'https://user:secret@example.com',
  ]) {
    await click(url);
    await delay(200);
    assert.equal(opened.length, 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  }
  await win.loadURL('about:blank');
  const previous = requests.length;
  await click('https://example.com/untrusted');
  for (let attempt = 0; requests.length === previous && attempt < 100; attempt++) await delay(50);
  assert.equal(requests.at(-1), 'https://example.com/untrusted');
  assert.equal(opened.length, 1);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  console.log(
    'PASS: Electron web-link delegation, unsafe destinations, untrusted origin and popup denial (OS adapter recorded).',
  );
}

void run()
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error);
      app.exit(1);
    },
  )
  .finally(() => server.close());
