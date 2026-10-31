import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from './service.js';
import { createApp } from '../app.js';
import { voiceConfig } from '../voice/config.js';
import { waitForBrowserPort } from './browser-startup.js';
const origin = 'http://127.0.0.1:3003';
const fixture = await testDatabase(),
  service = new AuthService(fixture.database.pool);
const config = voiceConfig();
if (!config) throw new Error('Run voice:setup and voice:up.');
const app = createApp({
  voiceConfig: { ...config, prefix: 'tricord-browser-smoke-' + randomUUID() + '-' },
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
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const port = await waitForBrowserPort(child, profile);
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
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
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

  // Exercise actual controlled React inputs, not API-only message creation.
  async function compose(value: string) {
    await wait("!!document.querySelector('textarea[name=message]')");
    await js(
      "(()=>{const input=document.querySelector('textarea[name=message]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input," +
        JSON.stringify(value) +
        ");input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await js('document.querySelector(\'button[aria-label="Send message"]\').click()');
    await wait("document.querySelector('textarea[name=message]').value===''");
  }
  const general = (
    await fixture.database.pool.query(
      "SELECT id FROM conversations WHERE kind='channel' AND name='general'",
    )
  ).rows[0].id;
  await compose('Browser message <img src=x onerror=window.tricordXss=true>');
  await wait("document.querySelector('.message-scroll').innerText.includes('Browser message')");
  assert.equal(await js('window.tricordXss===true'), false);
  const original = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE author_id=$1 AND conversation_id=$2',
      [user.id, general],
    )
  ).rows[0];
  assert.ok(original);
  const reply = await app.inject({
    url: '/api/conversations/' + general + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Reply from independent session', clientId: randomUUID() },
  });
  assert.equal(reply.statusCode, 200);
  await wait(
    "document.querySelector('.message-scroll').innerText.includes('Reply from independent session')",
  );
  await js('document.querySelector(\'button[aria-label="Edit message"]\').click()');
  await js(
    "(()=>{const input=document.querySelector('.edit-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Edited in browser');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await js("document.querySelector('.edit-form').requestSubmit()");
  await wait("document.querySelector('.message-body')?.innerText==='Edited in browser'");
  await screenshot('messaging-browser-channel.png');
  await js(
    'window.confirm=()=>true;document.querySelector(\'button[aria-label="Delete message"]\').click()',
  );
  await wait('!document.querySelector(\'[data-message-id="' + original.id + '"]\')');
  assert.equal(
    (await fixture.database.pool.query('SELECT body FROM messages WHERE id=$1', [original.id]))
      .rows[0].body,
    null,
  );
  await js('document.querySelector(\'button[aria-label="New direct message"]\').click()');
  await wait("!!document.querySelector('select[name=userId]')");
  await js("document.querySelector('select[name=userId]').value=" + JSON.stringify(owner.id));
  await click('Open conversation');
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await compose('Private browser DM');
  const dm = (
    await fixture.database.pool.query(
      "SELECT id FROM conversations WHERE kind='dm' AND (pair_low=$1 OR pair_high=$1)",
      [user.id],
    )
  ).rows[0];
  const dmHistory = await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    headers: ownerHeaders,
  });
  assert.equal(dmHistory.json().messages[0].body, 'Private browser DM');
  assert.equal(
    await js(
      "document.querySelector('.message-scroll').innerText.includes('Reply from independent session')",
    ),
    false,
  );

  // Unselected unread counts survive a full browser reload, then clear after focused reading.
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  const unreadReply = await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Unread ping @' + username, clientId: randomUUID() },
  });
  assert.equal(unreadReply.statusCode, 200);
  const badge = `document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')?.textContent==='1'`;
  await wait(badge);
  await wait(
    `document.querySelector('[data-conversation-id="${dm.id}"] .mention-badge')?.textContent==='@1'`,
  );
  await call('Page.reload');
  await wait("!!document.querySelector('[data-connection=connected]')");
  await wait(badge);
  await screenshot('unread-browser-badges.png');
  await js(`document.querySelector('[data-conversation-id="${dm.id}"]').click()`);
  await wait("document.querySelector('.message-scroll')?.innerText.includes('Unread ping')");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  const storedRead = (
    await fixture.database.pool.query(
      'SELECT last_seq FROM conversation_reads WHERE user_id=$1 AND conversation_id=$2',
      [user.id, dm.id],
    )
  ).rows[0];
  assert.equal(storedRead.last_seq, unreadReply.json().message.seq);
  // Controlled background/focus transitions exercise read gating without stealing the user's window.
  await js('document.hasFocus=()=>false');
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'While unfocused', clientId: randomUUID() },
  });
  await wait("document.querySelector('.message-scroll')?.innerText.includes('While unfocused')");
  await wait(badge);
  await js("delete document.hasFocus;window.dispatchEvent(new Event('focus'))");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);

  // Mock only the OS notification adapter; socket delivery, React handlers and navigation are real.
  await js(`window.notificationCalls=[]; window.Notification=class {
    static permission='granted'; static requestPermission(){return Promise.resolve('granted')}
    constructor(title,options){this.title=title;this.options=options;window.notificationCalls.push(this)}
    close(){this.onclose?.()}
  }`);
  await click('Enable notifications');
  await wait(
    "document.querySelector('.notification-settings button')?.getAttribute('aria-pressed')==='true'",
  );
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Secret alert body @' + username, clientId: randomUUID() },
  });
  await wait('window.notificationCalls.length===1');
  assert.equal(
    await js('window.notificationCalls[0].options.body'),
    'You were mentioned. Open Tricord to read it.',
  );
  await js('window.notificationCalls[0].onclick()');
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await click('Disable notifications');
  await wait(
    "document.querySelector('.notification-settings button')?.getAttribute('aria-pressed')==='false'",
  );
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Disabled alert', clientId: randomUUID() },
  });
  await wait(badge);
  assert.equal(await js('window.notificationCalls.length'), 1);

  // Reading older messages must neither jump to the bottom nor acknowledge newly arrived text.
  for (let i = 0; i < 6; i++)
    await app.inject({
      url: '/api/conversations/' + dm.id + '/messages',
      method: 'POST',
      headers: ownerHeaders,
      payload: { body: ('History line ' + i + '\n').repeat(12), clientId: randomUUID() },
    });
  await js(`document.querySelector('[data-conversation-id="${dm.id}"]').click()`);
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await js(
    `(()=>{const area=document.querySelector('.message-scroll');area.scrollTop=0;area.dispatchEvent(new Event('scroll'))})()`,
  );
  await wait("!!document.querySelector('.jump-latest')");
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Arrived while reading history', clientId: randomUUID() },
  });
  await wait(badge);
  assert.equal(await js("document.querySelector('.message-scroll').scrollTop < 100"), true);
  await click('Jump to latest messages');
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  const group = await app.inject({
    url: '/api/conversations',
    method: 'POST',
    headers: ownerHeaders,
    payload: { kind: 'group', name: 'Browser invitation group', userIds: [user.id] },
  });
  const groupId = group.json().conversation.id;
  await app.inject({
    url: '/api/conversations/' + groupId + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Hidden before joining', clientId: randomUUID() },
  });
  await wait(
    "document.querySelector('.invite-list')?.innerText.includes('Browser invitation group')",
  );
  await click('Accept');
  await wait(
    "document.querySelector('.channel-header strong')?.innerText==='Browser invitation group'",
  );
  assert.equal(
    await js(
      "document.querySelector('.message-scroll').innerText.includes('Hidden before joining')",
    ),
    false,
  );
  await compose('Group message from browser');
  await screenshot('messaging-browser-group.png');
  assert.equal(
    await js(
      "document.querySelector('.sidebar').scrollWidth<=document.querySelector('.sidebar').clientWidth",
    ),
    true,
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('messaging-browser-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.reload');
  await wait("!!document.querySelector('textarea[name=message]')");
  await js(
    "(()=>{[...document.querySelectorAll('.channels button')].find(b=>b.innerText.includes('Browser invitation group')).click();})()",
  );
  await wait(
    "document.querySelector('.message-scroll')?.innerText.includes('Group message from browser')",
  );
  await writeFile(
    path.join(artifacts, 'messaging-browser.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'composer persists',
          'independent-session realtime reply',
          'untrusted text stays text',
          'author edit',
          'author delete',
          'private DM UI',
          'conversation switching',
          'group invitation acceptance',
          'pre-join history hidden',
          'history survives reload',
          'responsive messaging layout',
          'unselected unread and mention badges',
          'unread progress survives reload',
          'focused reading clears unread',
          'unfocused conversation stays unread',
          'notification opt-in and privacy-safe body (OS adapter mocked)',
          'notification click opens conversation',
          'disabled notifications stay silent',
          'reading history keeps new messages unread until jump to latest',
        ],
      },
      null,
      2,
    ),
  );

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
  console.log(
    'PASS: Browser authentication (11 checks) and messaging/unread/notification (19 checks) in the configured headless Chromium browser.',
  );
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
