// Read-only sign-in-page check: no account creation, credentials or microphone access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const exe = path.resolve(process.argv[2]);
const profile = path.join(process.env.APPDATA, 'Rajcord');
const portFile = path.join(profile, 'DevToolsActivePort');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// The installed application must ignore these inherited overrides.
env.TRICORD_DEV_URL = 'http://127.0.0.1:5173';
env.TRICORD_SERVER_URL = 'https://invalid.example';
const child = spawn(exe, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
  windowsHide: true,
  stdio: 'ignore',
  env,
});
let socket;
try {
  let pages;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null)
      throw new Error('Installed Rajcord exited before the sign-in check.');
    try {
      const port = (await fs.readFile(portFile, 'utf8')).split('\n')[0];
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (pages.some((page) => page.type === 'page' && page.url === 'https://rajcord.com/')) break;
    } catch {
      /* Wait for the owned process. */
    }
    await delay(100);
  }
  const page = pages?.find((page) => page.type === 'page' && page.url === 'https://rajcord.com/');
  assert.ok(page, 'Installed app must connect to the exact production HTTPS origin.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(
        () => reject(new Error('Packaged renderer check timed out.')),
        20000,
      );
      const listener = (event) => {
        const response = JSON.parse(event.data);
        if (response.id !== requestId) return;
        clearTimeout(timer);
        socket.removeEventListener('message', listener);
        if (response.error)
          reject(
            new Error(`Packaged renderer command ${method} failed: ${response.error.message}`),
          );
        else resolve(response.result);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  let result;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await command('Runtime.evaluate', {
        expression: `document.querySelector('input[name=username]') ? ({isolated:typeof require==='undefined'&&typeof process==='undefined',version:window.tricordDesktop?.version,secure:isSecureContext,webrtc:typeof RTCPeerConnection==='function',media:!!navigator.mediaDevices}) : null`,
        returnByValue: true,
      });
      result = response.result?.value;
      if (result) break;
    } catch (error) {
      if (!error.message.includes('Execution context was destroyed')) throw error;
    }
    await delay(100);
  }
  assert.ok(result?.isolated && result.secure && result.webrtc && result.media);
  const pkg = JSON.parse(await fs.readFile('apps/desktop/package.json', 'utf8'));
  assert.equal(result.version, pkg.version);
  // CDP key events do not exercise native menu accelerators. Real tray/Quit behavior
  // remains a manual gate; terminate only this anonymous test-owned process.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([
    exited,
    delay(10000).then(() => {
      if (child.exitCode === null) throw new Error('Fixture process did not exit.');
    }),
  ]);
  console.log(
    'PASS installed Rajcord: production HTTPS sign-in, renderer isolation, version and secure media/WebRTC APIs.',
  );
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
