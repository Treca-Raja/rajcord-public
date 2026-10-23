import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from './service.js';
import { createApp } from '../app.js';
const origin = 'http://127.0.0.1:3003';
const fixture = await testDatabase(),
  service = new AuthService(fixture.database.pool);
const app = createApp({
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  rateLimits: false,
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
}).app;
const profile = await mkdtemp(path.join(tmpdir(), 'tricord-browser-smoke-'));
const artifacts = fileURLToPath(new URL('../../../../artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const executable =
  process.env.TRICORD_BROWSER_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let child: ReturnType<typeof spawn> | undefined, ws: WebSocket | undefined;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let sequence = 0;
async function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser command timed out: ' + method));
    }, 10000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    ws!.send(JSON.stringify({ id, method, params }));
  });
}
async function js<T = unknown>(expression: string): Promise<T> {
  const result = await call<{ result: { value: T }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
  );
  if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
  return result.result.value;
}
async function wait(expression: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await js(expression)) return;
    await delay(100);
  }
  throw new Error('Browser UI assertion timed out: ' + expression);
}
async function click(label: string) {
  await js(
    "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
      JSON.stringify(label) +
      ");if(!b)throw new Error('Button missing');b.click();})()",
  );
}
async function fill(values: Record<string, string>) {
  await js(
    '(()=>{for(const [key,value] of Object.entries(' +
      JSON.stringify(values) +
      ")){const input=document.querySelector('input[name='+key+']');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()",
  );
}
async function screenshot(name: string) {
  const result = await call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64'));
}
try {
  await app.listen({ host: '127.0.0.1', port: 3003 });
  const secret = randomUUID() + '-Browser',
    username = 'browser_' + randomUUID().replaceAll('-', '').slice(0, 20);
  const owner = await service.bootstrap(
    'owner_' + randomUUID().slice(0, 8),
    'Browser owner',
    secret,
  );
  const ownerLogin = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    headers: { origin },
    payload: { username: owner.username, password: secret, remember: false },
  });
  const ownerHeaders = {
    origin,
    cookie: ownerLogin.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': ownerLogin.json().csrfToken,
  };
  child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  let port = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    try {
      port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.match(port, /^\d+$/);
  const pages = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  ws = new WebSocket(pages.find((page) => page.type === 'page')!.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id: number;
      result: unknown;
      error?: { message: string };
    };
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener('open', () => resolve(), { once: true });
    ws!.addEventListener('error', () => reject(new Error('Browser connection failed')), {
      once: true,
    });
  });
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.navigate', { url: origin });
  await wait("!!document.querySelector('input[name=username]')");
  await screenshot('auth-browser-signin.png');
  assert.equal(
    await js(
      "typeof require==='undefined'&&typeof process==='undefined'&&typeof window.tricordDesktop==='undefined'",
    ),
    true,
  );
  await click('Create an account');
  await fill({ username, password: secret, displayName: 'Browser member' });
  await js("document.querySelector('form').requestSubmit()");
  await wait("!!document.querySelector('input[name=remember]')");
  await fill({ username, password: secret });
  await js(
    "document.querySelector('input[name=remember]').click();document.querySelector('form').requestSubmit()",
  );
  await wait("!!document.querySelector('[data-account-status=pending]')");
  assert.equal(await js("fetch('/api/members').then(r=>r.status)"), 403);
  const user = (
    await fixture.database.pool.query('SELECT id FROM users WHERE username=$1', [username])
  ).rows[0];
  const approval = await app.inject({
    url: '/api/admin/accounts/' + user.id,
    method: 'POST',
    headers: ownerHeaders,
    payload: { action: 'approve' },
  });
  assert.equal(approval.statusCode, 200);
  await wait("!!document.querySelector('[data-connection=connected]')");
  assert.equal(await js("fetch('/api/members').then(r=>r.status)"), 200);
  assert.equal(await js("document.cookie.includes('tricord_session')"), false);
  assert.equal(await js('Object.keys(localStorage).length'), 0);
  const cookieData = await call<{
    cookies: { name: string; httpOnly: boolean; sameSite: string; session: boolean }[];
  }>('Network.getCookies', { urls: [origin] });
  const sessionCookie = cookieData.cookies.find((cookie) => cookie.name === 'tricord_session');
  assert.ok(sessionCookie?.httpOnly);
  assert.equal(sessionCookie.sameSite, 'Strict');
  assert.equal(sessionCookie.session, false);
  await screenshot('auth-browser-approved.png');
  const candidate = await service.register({
    username: 'candidate_' + randomUUID().slice(0, 8),
    displayName: 'Approval candidate',
    password: secret,
  });
  await js("document.querySelector('button[aria-label=Settings]').click()");
  await wait("!!document.querySelector('[role=dialog]')");
  await click('People & approvals');
  await wait("document.body.innerText.includes('Approval candidate')");
  await click('Approve');
  await wait("document.body.innerText.includes('Account updated.')");
  assert.equal(
    (await fixture.database.pool.query('SELECT status FROM users WHERE id=$1', [candidate.id]))
      .rows[0].status,
    'approved',
  );
  await js('document.querySelector(\'button[aria-label="Close settings"]\').click()');
  await call('Page.reload');
  await wait("!!document.querySelector('[data-connection=connected]')");
  // Actual revocation is sent over the live account socket, removing the private UI.
  const suspended = await app.inject({
    url: '/api/admin/accounts/' + user.id,
    method: 'POST',
    headers: ownerHeaders,
    payload: { action: 'suspend' },
  });
  assert.equal(suspended.statusCode, 200);
  await wait("!!document.querySelector('input[name=username]')");
  assert.equal(await js("!!document.querySelector('.shell')"), false);
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await screenshot('auth-browser-mobile.png');
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  await writeFile(
    path.join(artifacts, 'auth-browser.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'registration',
          'pending restriction',
          'login and remember',
          'real-time approval',
          'approved API/socket',
          'HttpOnly SameSite cookie',
          'no localStorage tokens',
          'member approval UI',
          'reload restores session',
          'suspension removes private UI',
          'mobile layout',
        ],
        profile,
      },
      null,
      2,
    ),
  );
  console.log('PASS: Browser authentication flow (11 checks) in headless Microsoft Edge.');
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await call('Browser.close').catch(() => {});
    ws.close();
  }
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Browser closed'));
  }
  pending.clear();
  if (child && child.exitCode === null) {
    await delay(300);
    if (child.exitCode === null) child.kill();
  }
  await app.close();
  await fixture.cleanup();
}
