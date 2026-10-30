import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import { PRESENCE_TIMING } from '@tricord/shared';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from './service.js';
import { createApp } from '../app.js';
import { voiceConfig } from '../voice/config.js';
const origin = 'http://127.0.0.1:3003';
const fixture = await testDatabase(),
  service = new AuthService(fixture.database.pool);
const config = voiceConfig();
if (!config) throw new Error('Run voice:setup and voice:up.');
let tenorSearches = 0;
const mediaUrl =
  'https://media.giphy.com/media/rajcord-fixture/giphy.gif?cid=fixture&rid=giphy.gif';
const stillUrl = 'https://media.giphy.com/media/rajcord-fixture/100_s.gif?cid=fixture';
const tenorMediaUrl = 'https://media.tenor.com/rajcord-fixture/tenor.gif';
const tenorStillUrl = 'https://media.tenor.com/rajcord-fixture/preview.gif';
const giphyFixture = {
  meta: { status: 200, msg: 'OK' },
  data: [
    {
      id: 'giphy-fixture',
      title: 'Fixture wave',
      images: {
        original: { url: mediaUrl, width: '1', height: '1' },
        fixed_width_small: { url: mediaUrl, width: '1', height: '1' },
        fixed_width_small_still: { url: stillUrl, width: '1', height: '1' },
        fixed_height_small_still: { url: stillUrl, width: '1', height: '1' },
      },
    },
  ],
  pagination: { offset: 0, count: 1, total_count: 1 },
};
const app = createApp({
  gifSearch: {
    config: { giphyApiKey: 'fixture-public-giphy', tenorApiKey: 'fixture-private-tenor' },
    fetcher: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, 'https://tenor.googleapis.com');
      tenorSearches++;
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 'tenor-fixture',
              content_description: 'Fixture Tenor wave',
              media_formats: {
                gif: { url: tenorMediaUrl, dims: [1, 1] },
                tinygifpreview: { url: tenorStillUrl, dims: [1, 1] },
                gifpreview: { url: tenorStillUrl, dims: [1, 1] },
              },
            },
          ],
          next: '',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  },
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
const presencePeers: Socket[] = [];
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const cdpEvents = new Map<string, (params: unknown) => void>();
let sequence = 0;
async function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser command timed out: ' + method));
    }, 10000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function js<T = unknown>(expression: string): Promise<T> {
  const result = await call<{ result: { value: T }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
  );
  if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
  return result.result.value;
}
async function tabJs<T = unknown>(sessionId: string, expression: string): Promise<T> {
  const result = await call<{ result: { value: T }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) throw new Error('Second-tab evaluation failed.');
  return result.result.value;
}
async function waitCondition(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Browser condition timed out: ' + description);
}
async function wait(expression: string, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await js(expression)) return;
    await delay(100);
  }
  throw new Error(
    'Browser UI assertion timed out: ' +
      expression +
      '; sound status: ' +
      (await js("document.querySelector('.sound-settings [role=status]')?.textContent ?? 'none'")),
  );
}
async function click(label: string) {
  await js(
    "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
      JSON.stringify(label) +
      ");if(!b)throw new Error('Button missing');b.click();})()",
  );
}
async function reload() {
  await js('window.__reloadMarker=true');
  await call('Page.reload');
  await wait("window.__reloadMarker!==true && document.readyState==='complete'");
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
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
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
      method?: string;
      params?: unknown;
      result: unknown;
      error?: { message: string };
    };
    if (message.method) {
      cdpEvents.get(message.method)?.(message.params);
      return;
    }
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
  const coordinationKey = 'tricord-notification-coordination:' + user.id;
  const initialStorageKeys = await js<string[]>('Object.keys(localStorage)');
  assert.ok(
    initialStorageKeys.length <= 1 && initialStorageKeys.every((key) => key === coordinationKey),
  );
  assert.equal(
    await js(`(()=>{
    const stored=localStorage.getItem(${JSON.stringify(coordinationKey)});
    if(stored===null)return true;
    const state=JSON.parse(stored);
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return Object.keys(state).sort().join(',')==='peers,seen' &&
      Array.isArray(state.seen) && state.seen.length===0 &&
      Array.isArray(state.peers) && state.peers.length<=32 &&
      state.peers.every(peer=>Object.keys(peer).sort().join(',')==='at,focused,id,receiving,selected' &&
        uuid.test(peer.id) && (peer.selected===null || uuid.test(peer.selected)) &&
        typeof peer.focused==='boolean' && typeof peer.receiving==='boolean' && Number.isFinite(peer.at));
  })()`),
    true,
  );
  const cookieData = await call<{
    cookies: { name: string; httpOnly: boolean; sameSite: string; session: boolean }[];
  }>('Network.getCookies', { urls: [origin] });
  const sessionCookie = cookieData.cookies.find((cookie) => cookie.name === 'tricord_session');
  assert.ok(sessionCookie?.httpOnly);
  assert.equal(sessionCookie.sameSite, 'Strict');
  assert.equal(sessionCookie.session, false);
  await screenshot('auth-browser-approved.png');
  await wait("!!document.querySelector('.notification-invitation')");
  await click('Set up notifications');
  await wait(
    '!!document.querySelector(\'[aria-label="Account settings"] .notification-settings\')',
  );
  assert.equal(await js("!!document.querySelector('.sidebar .notification-settings')"), false);
  assert.equal(
    await js(
      "document.querySelector('.notification-settings button').getAttribute('aria-pressed')",
    ),
    'false',
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await js(
      'document.querySelector(\'[aria-label="Account settings"]\').scrollWidth<=document.querySelector(\'[aria-label="Account settings"]\').clientWidth',
    ),
    true,
  );
  assert.equal(
    await js(
      "document.querySelector('.notification-settings').scrollWidth<=document.querySelector('.notification-settings').clientWidth",
    ),
    true,
  );
  await screenshot('notification-settings-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await js('document.querySelector(\'button[aria-label="Close settings"]\').click()');
  await wait("!document.querySelector('.notification-invitation')");

  async function notificationSettings() {
    if (await js("!!document.querySelector('.notification-settings')")) return;
    await js('document.querySelector(\'button[aria-label="Settings"]\').click()');
    await wait('!!document.querySelector(\'[aria-label="Account settings"]\')');
    await click('Notifications');
    await wait("!!document.querySelector('.notification-settings')");
  }
  async function closeSettings() {
    await js('document.querySelector(\'button[aria-label="Close settings"]\')?.click()');
    await wait('!document.querySelector(\'[aria-label="Account settings"]\')');
  }

  // An HTTP login alone is offline. Two independent application connections still
  // produce one account row, and closing either cannot erase the other connection.
  const ownerRow = `[data-member-id="${owner.id}"]`;
  await wait(`document.querySelector('${ownerRow}')?.dataset.presence==='offline'`);
  async function connectPresencePeer() {
    const peer = io(origin, {
      transports: ['websocket'],
      extraHeaders: { origin, cookie: ownerHeaders.cookie },
      auth: { csrfToken: ownerLogin.json().csrfToken },
      reconnection: false,
    });
    presencePeers.push(peer);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Presence peer connection timed out')), 5000);
      peer.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return peer;
  }
  const firstPeer = await connectPresencePeer();
  await wait(`document.querySelector('${ownerRow}')?.dataset.presence==='online'`, 5000);
  const secondPeer = await connectPresencePeer();
  firstPeer.disconnect();
  assert.equal(await js(`document.querySelectorAll('${ownerRow}').length`), 1);
  await js('document.hasFocus=()=>false');
  assert.equal(await js(`document.querySelector('${ownerRow}')?.dataset.presence`), 'online');
  await js('delete document.hasFocus');
  secondPeer.disconnect();
  await wait(
    `document.querySelector('${ownerRow}')?.dataset.presence==='offline'`,
    PRESENCE_TIMING.reconnectGraceMs + 5000,
  );
  await js(
    `window.rosterRefreshes=0;window.originalPresenceFetch=window.fetch;window.fetch=async(...args)=>{const result=await window.originalPresenceFetch(...args);if(args[0]==='/api/members')window.rosterRefreshes++;return result};document.querySelector('${ownerRow}').focus();window.dispatchEvent(new Event('focus'))`,
  );
  await wait('window.rosterRefreshes>0');
  await wait("!!document.querySelector('[data-presence-state=ready]')");
  await wait(`document.activeElement?.dataset.memberId===${JSON.stringify(owner.id)}`);
  await js(
    "document.querySelector('.chat').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.activeElement.blur();window.rosterRefreshes=0;window.dispatchEvent(new Event('focus'))",
  );
  await wait('window.rosterRefreshes>0');
  await wait("!!document.querySelector('[data-presence-state=ready]')");
  assert.equal(await js('document.activeElement?.hasAttribute("data-member-id")'), false);
  await js('window.fetch=window.originalPresenceFetch;delete window.originalPresenceFetch');

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
    assert.equal(
      await js("document.activeElement===document.querySelector('textarea[name=message]')"),
      true,
      'Sending must leave the composer ready for the next message',
    );
  }
  const general = (
    await fixture.database.pool.query(
      "SELECT id FROM conversations WHERE kind='channel' AND name='general'",
    )
  ).rows[0].id;
  const browserMessage =
    'Browser message <img src=x onerror=window.tricordXss=true> https://github.com, [Docs](https://example.com/docs) [bad](javascript:alert(1))';
  await compose(browserMessage);
  await wait("document.querySelector('.message-scroll').innerText.includes('Browser message')");
  assert.equal(await js('window.tricordXss===true'), false);
  const original = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE author_id=$1 AND conversation_id=$2 AND body=$3 ORDER BY seq DESC LIMIT 1',
      [user.id, general, browserMessage],
    )
  ).rows[0];
  assert.ok(original);
  const messageSelector = '[data-message-id="' + original.id + '"]';
  const secureLinks = `(()=>{const body=document.querySelector('${messageSelector} .message-body');if(!body)return false;const links=[...body.querySelectorAll('a')];return links.length===2 && links[0].textContent==='https://github.com' && links[1].textContent==='Docs' && links.every(a=>a.target==='_blank' && a.rel==='noopener noreferrer' && a.title===a.href && /^https:/.test(a.href)) && !body.querySelector('img') && body.textContent.includes('[bad](javascript:alert(1))')})()`;
  await wait(secureLinks);
  assert.equal(await js("!!document.querySelector('.message-actions')"), false);
  assert.equal(await js("!!document.querySelector('.message-context-menu')"), false);
  await reload();
  await wait(secureLinks);
  const reply = await app.inject({
    url: '/api/conversations/' + general + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: {
      body: 'Reply from independent session https://example.com/reply',
      clientId: randomUUID(),
    },
  });
  assert.equal(reply.statusCode, 200);
  await wait(
    "document.querySelector('.message-scroll').innerText.includes('Reply from independent session')",
  );
  assert.equal(
    await js('!!document.querySelector(\'.message-body a[href="https://example.com/reply"]\')'),
    true,
  );
  await messageAction(original.id, 'Edit message');
  await js(
    "(()=>{const input=document.querySelector('.edit-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Edited in browser https://example.com/edited');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await js("document.querySelector('.edit-form').requestSubmit()");
  await wait(
    "document.querySelector('.message-body')?.innerText==='Edited in browser https://example.com/edited'",
  );
  assert.equal(
    await js('!!document.querySelector(\'.message-body a[href="https://example.com/edited"]\')'),
    true,
  );
  await screenshot('messaging-browser-channel.png');
  await js('window.confirm=()=>true');
  await messageAction(original.id, 'Delete message');
  await wait('!document.querySelector(\'[data-message-id="' + original.id + '"]\')');
  assert.equal(
    (await fixture.database.pool.query('SELECT body FROM messages WHERE id=$1', [original.id]))
      .rows[0].body,
    null,
  );
  await js(
    'document.querySelector(\'button[aria-label="Manage categories"]\').focus(); document.querySelector(\'button[aria-label="Manage categories"]\').click()',
  );
  await wait('!!document.querySelector(\'form[aria-label="Create category"]\')');
  await fill({ name: 'Friends 🎮', position: '10' });
  await js('document.querySelector(\'form[aria-label="Create category"]\').requestSubmit()');
  await wait("document.querySelector('.category-settings h3')?.textContent==='Friends 🎮'");
  const categoryId = (
    await fixture.database.pool.query("SELECT id FROM channel_categories WHERE name='Friends 🎮'")
  ).rows[0].id;
  await js('document.querySelector(\'button[aria-label="Close dialog"]\').focus()');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 8 });
  assert.equal(await js("document.activeElement?.textContent==='Remove category'"), true);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await wait("!document.querySelector('[role=dialog]')");
  assert.equal(
    await js('document.activeElement?.getAttribute("aria-label")==="Manage categories"'),
    true,
  );

  await js('document.querySelector(\'button[aria-label="Create channel"]\').click()');
  await fill({ name: 'Café 🎮 Club', position: '5' });
  await js(
    `document.querySelector('textarea[name=topic]').value='Games and friends'; document.querySelector('select[name=categoryId]').value=${JSON.stringify(categoryId)}`,
  );
  await click('Create');
  await wait("document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club'");
  assert.equal(
    await js("document.querySelector('.channel-topic')?.textContent"),
    'Games and friends',
  );
  const createdChannel = (
    await fixture.database.pool.query("SELECT id FROM conversations WHERE name='Café 🎮 Club'")
  ).rows[0].id;
  assert.equal(
    await js(
      `!!document.querySelector('.channel-category[data-category-id="${categoryId}"] [data-conversation-id="${createdChannel}"]')`,
    ),
    true,
  );
  await compose('History stays with this channel');
  await call('Page.reload');
  await wait(`!!document.querySelector('[data-conversation-id="${createdChannel}"]')`);
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait(
    "document.querySelector('.message-scroll')?.textContent.includes('History stays with this channel')",
  );
  assert.equal(
    await js("document.querySelector('.channel-topic')?.textContent"),
    'Games and friends',
  );
  await js('document.querySelector(\'button[aria-label="Manage conversation"]\').click()');
  await fill({ name: 'Local unsaved name' });
  const beforeEdit = (
    await fixture.database.pool.query('SELECT metadata_revision FROM conversations WHERE id=$1', [
      createdChannel,
    ])
  ).rows[0].metadata_revision;
  const concurrentEdit = await app.inject({
    method: 'PATCH',
    url: '/api/conversations/' + createdChannel,
    headers: ownerHeaders,
    payload: { topic: 'Changed in another session', expectedRevision: beforeEdit },
  });
  assert.equal(concurrentEdit.statusCode, 200);
  await wait(
    "document.querySelector('.channel-settings')?.textContent.includes('changed in another window')",
  );
  assert.equal(
    await js("document.querySelector('.channel-settings input[name=name]').value"),
    'Local unsaved name',
  );
  assert.equal(
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save channel details').disabled",
    ),
    true,
  );
  await click('Reload channel details');
  assert.equal(
    await js("document.querySelector('.channel-settings input[name=name]').value"),
    'Café 🎮 Club',
  );
  await fill({ name: 'Café 🎮 Club renamed', position: '2' });
  await js("document.querySelector('textarea[name=topic]').value='Updated in browser'");
  await click('Save channel details');
  await wait(
    "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
  );
  assert.equal(
    await js("document.querySelector('.channel-topic')?.textContent"),
    'Updated in browser',
  );
  await click('Archive channel');
  await wait("document.querySelector('textarea[name=message]')?.disabled");
  assert.equal(await js("document.querySelector('.channel-settings fieldset').disabled"), true);
  await click('Restore channel');
  await wait("!document.querySelector('textarea[name=message]')?.disabled");
  await js('document.querySelector(\'button[aria-label="Close dialog"]\').click()');
  await js('document.querySelector(\'button[aria-label="Manage categories"]\').click()');
  await js(
    `(()=>{const form=document.querySelector('.category-settings[data-category-id="${categoryId}"] form'); form.querySelector('input[name=name]').value='Our friends 🎮'; form.querySelector('input[name=position]').value='1'; form.requestSubmit()})()`,
  );
  await wait(
    `document.querySelector('.channel-category[data-category-id="${categoryId}"] h2')?.textContent==='Our friends 🎮'`,
  );
  await click('Remove category');
  await click('Confirm remove category');
  await wait(`!document.querySelector('.category-settings[data-category-id="${categoryId}"]')`);
  assert.equal(
    await js(
      `!!document.querySelector('.channel-category[data-category-id="uncategorized"] [data-conversation-id="${createdChannel}"]')`,
    ),
    true,
  );
  await js('document.querySelector(\'button[aria-label="Close dialog"]\').click()');
  await wait(
    "document.querySelector('.message-scroll')?.textContent.includes('History stays with this channel')",
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await js('document.querySelector(\'button[aria-label="Manage conversation"]\').click()');
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  assert.equal(
    await js(
      "document.querySelector('.chat-dialog').scrollWidth<=document.querySelector('.chat-dialog').clientWidth",
    ),
    true,
  );
  await screenshot('channels-browser-mobile.png');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.reload');
  await wait(`!!document.querySelector('[data-conversation-id="${createdChannel}"]')`);
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait(
    "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
  );
  assert.equal(
    await js("document.querySelector('.channel-topic')?.textContent"),
    'Updated in browser',
  );
  await wait(
    "document.querySelector('.message-scroll')?.textContent.includes('History stays with this channel')",
  );
  const persistedChannel = (
    await fixture.database.pool.query(
      'SELECT category_id,position,archived FROM conversations WHERE id=$1',
      [createdChannel],
    )
  ).rows[0];
  assert.deepEqual(persistedChannel, { category_id: null, position: 2, archived: false });

  const rootMessage = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE conversation_id=$1 ORDER BY seq LIMIT 1',
      [createdChannel],
    )
  ).rows[0].id;
  const timelineMessage = `.message-scroll [data-message-id="${rootMessage}"]`;
  const reactionSelector = `.message-scroll [data-message-entry-id="${rootMessage}"] .chat-message-reactions`;
  async function messageAction(id: string, label: string, scope = '.message-scroll') {
    const action =
      label === 'Pin'
        ? 'Pin message'
        : label === 'React'
          ? 'Add reaction'
          : label.startsWith('Thread')
            ? label.replace('Thread', 'Open thread')
            : label;
    const selector = JSON.stringify(scope + ' [data-message-id="' + id + '"]');
    await wait('!!document.querySelector(' + selector + ')');
    await js(`(()=>{const item=document.querySelector(${selector});item.scrollIntoView({block:'nearest'});
      const bounds=item.getBoundingClientRect();item.dispatchEvent(new MouseEvent('contextmenu',
        {bubbles:true,cancelable:true,clientX:bounds.left+100,clientY:bounds.top+20}));})()`);
    await wait('!!document.querySelector(\'[role=menu][aria-label="Message actions"]\')');
    await js(
      `(()=>{const menu=document.querySelector('[role=menu][aria-label="Message actions"]');
        const button=[...menu.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(action)});
        if(!button)throw new Error('Message action missing');button.click()})()`,
    );
  }
  async function writeDraft(value: string) {
    await js(
      `(()=>{const input=document.querySelector('textarea[name=message]');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  }
  async function openEmoji(scope: string) {
    const selector = JSON.stringify(scope + ' .emoji-picker > button');
    await wait('!!document.querySelector(' + selector + ')');
    await js('document.querySelector(' + selector + ').click()');
  }
  await messageAction(rootMessage, 'Pin');
  await wait(
    `document.querySelector('${timelineMessage} .chat-message-information')?.textContent.includes('Pinned')`,
  );
  let pausedPinsRequest: string | undefined;
  cdpEvents.set('Fetch.requestPaused', (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'requestId' in value &&
      typeof value.requestId === 'string'
    )
      pausedPinsRequest = value.requestId;
  });
  await call('Fetch.enable', {
    patterns: [
      {
        urlPattern: origin + '/api/conversations/' + createdChannel + '/pins*',
        requestStage: 'Request',
      },
    ],
  });
  const timelineWidthBeforePins = await js<number>(
    "document.querySelector('.message-scroll').clientWidth",
  );
  const pinnedShell = await js<{
    milliseconds: number;
    moving: boolean;
  }>(`new Promise((resolve,reject)=>{
    const start=performance.now();[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Pinned messages').click();
    requestAnimationFrame(()=>{
      const panel=document.querySelector('.chat-feature-panel[aria-busy=true]');
      if(!panel?.querySelector('.panel-loading')){reject(new Error('Pinned shell must render before its network response'));return;}
      resolve({milliseconds:performance.now()-start,moving:panel.getAnimations().some(animation=>animation.playState==='running')});
    });
  })`);
  await waitCondition(
    async () => pausedPinsRequest !== undefined,
    'pins request paused behind rendered loading shell',
  );
  assert.equal(
    await js("document.querySelector('.chat-feature-panel[aria-busy=true]')!==null"),
    true,
  );
  assert.equal(
    pinnedShell.moving,
    true,
    'Pinned messages must open with an actual running transition',
  );
  assert.ok(
    (await js<number>(
      "parseFloat(getComputedStyle(document.querySelector('.chat-feature-panel')).transitionDuration)",
    )) <= 0.18,
  );
  console.log(
    'Pinned panel shell rendered before response: ' + pinnedShell.milliseconds.toFixed(1) + ' ms.',
  );
  await call('Fetch.continueRequest', { requestId: pausedPinsRequest });
  await call('Fetch.disable');
  cdpEvents.delete('Fetch.requestPaused');
  await wait(`!!document.querySelector('.chat-feature-panel [data-message-id="${rootMessage}"]')`);
  assert.equal(
    await js("document.querySelector('.chat-feature-panel h2').textContent"),
    'Pinned messages (1)',
  );
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(
    await js("getComputedStyle(document.querySelector('.chat-feature-panel')).animationName"),
    'none',
  );
  assert.equal(
    await js(
      "getComputedStyle(document.querySelector('.manage-categories-link')).transitionDuration",
    ),
    '0s',
  );
  await call('Emulation.setEmulatedMedia', { features: [] });
  await click('Pinned messages');
  await wait(
    "document.querySelector('.chat-tools button')?.getAttribute('aria-expanded')==='false'",
  );
  await wait("!document.querySelector('.chat-feature-panel')");
  assert.equal(
    await js("document.querySelector('.message-scroll').clientWidth"),
    timelineWidthBeforePins,
  );
  await click('Pinned messages');
  await wait("document.querySelector('.chat-feature-panel')?.dataset.open==='true'");
  await click('Pinned messages');
  await wait(
    "(()=>{const panel=document.querySelector('.chat-feature-panel');return !!panel&&panel.inert&&panel.dataset.open==='false'})()",
  );
  await wait("!document.querySelector('.chat-feature-panel')");
  const replyResponse = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + createdChannel + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Reply for @' + username, clientId: randomUUID(), replyToId: rootMessage },
  });
  assert.equal(replyResponse.statusCode, 200);
  const replyId = replyResponse.json().message.id;
  await wait(
    `!!document.querySelector('.message-scroll [data-message-id="${replyId}"] .reply-quote')`,
  );
  assert.equal(
    await js(
      `document.querySelector('.message-scroll [data-message-id="${replyId}"] .message-body mark')?.textContent`,
    ),
    '@' + username,
  );
  await js(
    `document.querySelector('.message-scroll [data-message-id="${replyId}"] .reply-quote').click()`,
  );
  await wait(`(()=>{
    const area=document.querySelector('.message-scroll');
    const target=area?.querySelector('[data-message-id="${rootMessage}"]');
    if(!target||target.dataset.highlighted!=='true')return false;
    const bounds=target.getBoundingClientRect(), viewport=area.getBoundingClientRect();
    return bounds.top>=viewport.top&&bounds.bottom<=viewport.bottom;
  })()`);
  assert.ok(
    await js(
      `(()=>{const row=document.querySelector('${timelineMessage}');const style=getComputedStyle(row);return style.outlineStyle==='solid'&&parseFloat(style.outlineWidth)>0&&parseFloat(style.outlineOffset)>0&&row.scrollWidth<=row.clientWidth})()`,
    ),
    'Opening a quote keeps the original framed with space around the avatar and no row overflow',
  );
  assert.ok(
    (await js<number>(
      `parseFloat(getComputedStyle(document.querySelector('.message-scroll [data-message-id="${replyId}"] .reply-quote')).borderTopWidth)`,
    )) > 0,
    'The quoted preview has its own translucent frame',
  );
  await messageAction(rootMessage, 'Thread (1)');
  await wait(
    "document.querySelector('.chat-feature-panel')?.getAttribute('aria-label')==='Thread'",
  );
  await wait(`!!document.querySelector('.chat-feature-panel [data-message-id="${replyId}"]')`);
  const threadRead =
    (
      await fixture.database.pool.query(
        'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
        [createdChannel, user.id],
      )
    ).rows[0]?.last_seq ?? '0';
  const unseenReply = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + createdChannel + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Thread-only unread', clientId: randomUUID(), replyToId: replyId },
  });
  assert.equal(unseenReply.statusCode, 200);
  await wait(
    "document.querySelector('.chat-feature-panel')?.textContent.includes('Thread-only unread')",
  );
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
        [createdChannel, user.id],
      )
    ).rows[0]?.last_seq ?? '0',
    threadRead,
  );
  await messageAction(replyId, 'Reply', '.chat-panel-history');
  await wait(
    `document.querySelector('.message-scroll [data-message-id="${replyId}"]')?.dataset.replyTarget==='true'`,
  );
  await compose('Replying to a reply');
  const nestedReply = (
    await fixture.database.pool.query(
      'SELECT reply_to_id,thread_root_id FROM messages WHERE conversation_id=$1 AND body=$2',
      [createdChannel, 'Replying to a reply'],
    )
  ).rows[0];
  assert.deepEqual(nestedReply, { reply_to_id: replyId, thread_root_id: rootMessage });
  async function revisitChannel() {
    await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
    await wait("document.querySelector('.channel-header strong')?.textContent==='general'");
    await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
    await wait(
      "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
    );
  }
  const rootLookup = origin + '/api/conversations/' + createdChannel + '/messages/' + rootMessage;
  const replyBody = (
    await fixture.database.pool.query('SELECT body FROM messages WHERE id=$1', [replyId])
  ).rows[0].body;
  // A delayed restoration of an older target must not replace a newly chosen one.
  await messageAction(rootMessage, 'Reply');
  await wait("!!document.querySelector('.reply-target')");
  let heldRestoration: string | undefined;
  cdpEvents.set('Fetch.requestPaused', (value) => {
    if (value && typeof value === 'object' && 'requestId' in value)
      heldRestoration = String(value.requestId);
  });
  await call('Fetch.enable', { patterns: [{ urlPattern: rootLookup, requestStage: 'Request' }] });
  await revisitChannel();
  await waitCondition(async () => heldRestoration !== undefined, 'reply restoration held');
  await messageAction(replyId, 'Reply');
  await wait(
    `document.querySelector('.reply-target .truncate')?.textContent.includes(${JSON.stringify(replyBody)})`,
  );
  await call('Fetch.continueRequest', { requestId: heldRestoration });
  await call('Fetch.disable');
  cdpEvents.delete('Fetch.requestPaused');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    await js(
      `document.querySelector('.reply-target .truncate')?.textContent.includes(${JSON.stringify(replyBody)})`,
    ),
    true,
    'A late restoration response must not replace the newly selected reply target',
  );
  await compose('Reply after late restoration');
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT reply_to_id FROM messages WHERE conversation_id=$1 AND body=$2',
        [createdChannel, 'Reply after late restoration'],
      )
    ).rows[0].reply_to_id,
    replyId,
    'Displayed and sent reply targets must match',
  );
  // A transient lookup failure keeps the target, pauses sending and recovers through Retry.
  await messageAction(rootMessage, 'Reply');
  await writeDraft('Keep this draft');
  cdpEvents.set('Fetch.requestPaused', (value) => {
    if (value && typeof value === 'object' && 'requestId' in value)
      void call('Fetch.fulfillRequest', {
        requestId: String(value.requestId),
        responseCode: 503,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ error: 'Temporarily unavailable' })).toString('base64'),
      });
  });
  await call('Fetch.enable', { patterns: [{ urlPattern: rootLookup, requestStage: 'Request' }] });
  await revisitChannel();
  await wait("!!document.querySelector('.reply-target.form-error')");
  assert.equal(
    await js("document.querySelector('textarea[name=message]').value"),
    'Keep this draft',
  );
  assert.equal(
    await js(`document.querySelector('button[aria-label="Send message"]').disabled`),
    true,
    'Sending must pause while the reply target is unresolved',
  );
  await call('Fetch.disable');
  cdpEvents.delete('Fetch.requestPaused');
  await js(
    "[...document.querySelectorAll('.reply-target.form-error button')].find(button=>button.textContent.trim()==='Retry').click()",
  );
  await wait(
    "!!document.querySelector('.reply-target:not(.form-error)') && !document.querySelector('.reply-target.form-error')",
  );
  await js(`document.querySelector('button[aria-label="Send message"]').click()`);
  await wait("document.querySelector('textarea[name=message]').value===''");
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT reply_to_id FROM messages WHERE conversation_id=$1 AND body=$2',
        [createdChannel, 'Keep this draft'],
      )
    ).rows[0].reply_to_id,
    rootMessage,
    'A retained reply target must survive a transient lookup failure',
  );
  const beforeReactionHeight = await js<number>(
    `document.querySelector('${timelineMessage}').getBoundingClientRect().height`,
  );
  await messageAction(rootMessage, 'React');
  await wait('!!document.querySelector(\'.message-context-menu button[aria-label="Thumbs up"]\')');
  await js(
    'document.querySelector(\'.message-context-menu button[aria-label="Thumbs up"]\').click()',
  );
  await wait(`document.querySelector('${reactionSelector} button')?.textContent.includes('1')`);
  assert.equal(
    await js(`document.querySelector('${timelineMessage}').getBoundingClientRect().height`),
    beforeReactionHeight,
    'Reactions must not expand the message highlight area',
  );
  assert.equal(
    await js(
      `document.querySelector('${timelineMessage}').contains(document.querySelector('${reactionSelector}'))`,
    ),
    false,
  );
  assert.ok(
    await js(`Math.abs(document.querySelector('${reactionSelector}').getBoundingClientRect().left-
    document.querySelector('${timelineMessage} .chat-message-content').getBoundingClientRect().left)<=1`),
    'Detached reactions must align with the message text',
  );
  await js(`document.querySelector('${reactionSelector} button').click()`);
  await wait(`!document.querySelector('${reactionSelector} button')`);
  await messageAction(rootMessage, 'React');
  await wait('!!document.querySelector(\'.message-context-menu button[aria-label="Thumbs up"]\')');
  await js(
    'document.querySelector(\'.message-context-menu button[aria-label="Thumbs up"]\').click()',
  );
  await wait(
    `document.querySelector('${reactionSelector} button')?.getAttribute('aria-pressed')==='true'`,
  );
  await js(`document.querySelector('${timelineMessage}').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', modifiers: 8 });
  await wait('!!document.querySelector(\'[role=menu][aria-label="Message actions"]\')');
  assert.equal(await js("document.activeElement?.getAttribute('role')"), 'menuitem');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
  assert.match(await js<string>('document.activeElement?.textContent'), /Open thread/);
  await screenshot('chat-message-menu.png');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await wait("!document.querySelector('.message-context-menu')");
  assert.equal(
    await js(`document.activeElement===document.querySelector('${timelineMessage}')`),
    true,
  );

  await writeDraft('@');
  await wait(`!!document.querySelector('#mention-option-${user.id}')`);
  assert.match(
    await js<string>(`document.querySelector('#mention-option-${user.id}').textContent`),
    /You/,
  );
  await js(`document.querySelector('#mention-option-${user.id}').click()`);
  await wait(
    `document.querySelector('textarea[name=message]').value===${JSON.stringify('@' + username + ' ')}`,
  );
  assert.equal(
    await js('!!document.querySelector(\'.live-composer button[aria-label="Insert emoji"]\')'),
    true,
  );
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await wait("document.querySelector('textarea[name=message]').value===''");
  assert.equal(
    await js("document.activeElement===document.querySelector('textarea[name=message]')"),
    true,
  );
  const selfMention = (
    await fixture.database.pool.query(
      'SELECT m.id,(SELECT count(*)::int FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$1) count FROM messages m WHERE m.conversation_id=$2 AND m.body=$3',
      [user.id, createdChannel, '@' + username + ' '],
    )
  ).rows[0];
  assert.ok(selfMention);
  assert.equal(
    selfMention.count,
    0,
    'Self autocomplete must not create self alerts/unread mentions',
  );
  await wait(
    `document.querySelector('.message-scroll [data-message-id="${selfMention.id}"] mark')?.textContent===${JSON.stringify('@' + username)}`,
  );
  await compose('Compact follow-up');
  const followup = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE conversation_id=$1 AND body=$2',
      [createdChannel, 'Compact follow-up'],
    )
  ).rows[0].id;
  await wait(
    `!!document.querySelector('.message-scroll [data-message-id="${followup}"].consecutive-message')`,
  );
  const density = await js<{ height: number; gap: number }>(`(()=>{
    const previous=document.querySelector('.message-scroll [data-message-id="${selfMention.id}"]').getBoundingClientRect();
    const current=document.querySelector('.message-scroll [data-message-id="${followup}"]').getBoundingClientRect();
    return {height:current.height,gap:current.top-previous.bottom};
  })()`);
  assert.ok(
    density.height <= 56,
    'One-line consecutive messages must not reserve an avatar-sized row',
  );
  assert.equal(
    await js(
      `getComputedStyle(document.querySelector('.message-scroll [data-message-id="${followup}"] .chat-message-author strong')).display!=='none'`,
    ),
    true,
    'Every message, including consecutive messages, must show its sender',
  );
  assert.ok(
    await js(`Math.abs(document.querySelector('.message-scroll [data-message-id="${followup}"] .chat-message-content').getBoundingClientRect().left-
    document.querySelector('${timelineMessage} .chat-message-content').getBoundingClientRect().left)<=1`),
    'Consecutive sender names and message text must retain the same alignment',
  );
  assert.ok(
    await js(`(()=>{
    const item=document.querySelector('.message-scroll [data-message-id="${followup}"]');
    const author=item.querySelector('.chat-message-author').getBoundingClientRect();
    const body=item.querySelector('.chat-message-content').getBoundingClientRect();
    return Math.abs(author.left-body.left)<=1 && body.top>=author.bottom && body.top-author.bottom<=4;
  })()`),
    'Sender and text must share a left edge with a compact header above the message',
  );
  assert.ok(
    await js(`(()=>{
    const item=document.querySelector('.message-scroll [data-message-id="${followup}"]');
    const author=item.querySelector('.chat-message-author').getBoundingClientRect();
    const body=item.querySelector('.chat-message-content').getBoundingClientRect();
    const time=item.querySelector('.chat-message-information').getBoundingClientRect();
    return author.right<=time.left && body.left===author.left && item.scrollWidth<=item.clientWidth;
  })()`),
    'Sender and timestamp must fit above the text without overlapping',
  );
  assert.ok(density.gap <= 4, 'Consecutive message spacing must stay compact');
  await screenshot('chat-compact-density.png');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await js(
      "document.querySelector('.message-scroll').scrollWidth<=document.querySelector('.message-scroll').clientWidth",
    ),
    true,
  );
  assert.equal(
    await js(
      "[...document.querySelectorAll('.message-scroll .chat-message-row')].every(row=>row.scrollWidth<=row.clientWidth)",
    ),
    true,
  );
  assert.equal(
    await js(
      "[...document.querySelectorAll('.message-scroll .chat-message-author strong')].every(name=>getComputedStyle(name).display!=='none')",
    ),
    true,
  );
  await screenshot('chat-inline-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await messageAction(rootMessage, 'React');
  await wait("!!document.querySelector('.message-context-menu input[type=search]')");
  await js(`(()=>{const input=document.querySelector('.message-context-menu input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'woman technologist medium skin tone');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(
    "!![...document.querySelectorAll('.message-context-menu .emoji-picker-grid button')].find(button=>button.textContent==='👩🏽‍💻')",
  );
  assert.ok(
    (await js<number>(
      "document.querySelectorAll('.message-context-menu .emoji-picker-grid button').length",
    )) <= 64,
  );
  await js(
    "[...document.querySelectorAll('.message-context-menu .emoji-picker-grid button')].find(button=>button.textContent==='👩🏽‍💻').click()",
  );
  await wait(`document.querySelector('${reactionSelector}')?.textContent.includes('👩🏽‍💻')`);
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT count(*)::int count FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',
        [rootMessage, user.id, '👩🏽‍💻'],
      )
    ).rows[0].count,
    1,
  );

  await writeDraft('@' + owner.username.slice(0, 6));
  await wait(`!!document.querySelector('#mention-option-${owner.id}')`);
  await js(`document.querySelector('#mention-option-${owner.id}').click()`);
  await wait(
    `document.querySelector('textarea[name=message]').value===${JSON.stringify('@' + owner.username + ' ')}`,
  );
  const unsent = '@' + owner.username + ' ';
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.textContent==='general'");
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait(
    "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
  );
  assert.equal(await js("document.querySelector('textarea[name=message]').value"), unsent);
  await call('Page.reload');
  await wait(`!!document.querySelector('[data-conversation-id="${createdChannel}"]')`);
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait("document.querySelector('textarea[name=message]')?.value===''");
  await openEmoji('.chat-composer-controls');
  const artworkPixels = await js<number[]>(`(async()=>{
    const icons=['1f469-1f3fd-200d-1f4bb','1f1ed-1f1f7','1f9d1-200d-1f91d-200d-1f9d1','1f3ae'];
    return Promise.all(icons.map(icon=>new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>{
        const canvas=document.createElement('canvas');canvas.width=36;canvas.height=36;
        const context=canvas.getContext('2d');context.drawImage(image,0,0,36,36);
        const pixels=context.getImageData(0,0,36,36).data;let count=0;
        for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)count++;
        resolve(count);
      };image.onerror=()=>reject(new Error('Local emoji artwork failed to load'));
      image.src='/emoji/17-b6b55fef/'+icon+'.svg';
    })));
  })()`);
  assert.ok(
    artworkPixels.every((pixels) => pixels > 100),
    'Joined, toned and flag emoji must render visible local SVG artwork, not blank font glyphs',
  );
  await wait(
    '!!document.querySelector(\'.chat-composer-controls button[aria-label="Thumbs up"]\')',
  );
  await js(
    'document.querySelector(\'.chat-composer-controls button[aria-label="Thumbs up"]\').click()',
  );
  await wait("document.querySelector('textarea[name=message]').value==='👍'");
  await writeDraft('');
  await openEmoji('.chat-composer-controls');
  await wait("!!document.querySelector('.chat-composer-controls .emoji-search input')");
  await js(`(()=>{const input=document.querySelector('.chat-composer-controls .emoji-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Croatia');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(
    "!![...document.querySelectorAll('.chat-composer-controls .emoji-picker-grid button')].find(button=>button.textContent==='🇭🇷')",
  );
  await wait("!document.querySelector('.emoji-loading')");
  await wait(
    "[...document.querySelectorAll('.emoji-picker-grid img')].every(image=>image.complete&&image.naturalWidth>0)",
  );
  assert.equal(await js("!!document.querySelector('.emoji-pagination')"), false);
  assert.equal(await js('!!document.querySelector(\'[aria-label="Emoji categories"]\')'), true);
  await screenshot('emoji-full-search.png');
  await js(
    "[...document.querySelectorAll('.chat-composer-controls .emoji-picker-grid button')].find(button=>button.textContent==='🇭🇷').click()",
  );
  await wait("document.querySelector('textarea[name=message]').value==='🇭🇷'");
  await writeDraft('');

  await fixture.database.pool.query(
    `WITH updated AS (UPDATE conversations SET last_seq=last_seq+60,last_change=last_change+60 WHERE id=$1 RETURNING last_seq,last_change)
     INSERT INTO messages(conversation_id,author_id,client_id,request_hash,seq,change,body,created_at)
     SELECT $1,$2,gen_random_uuid(),$3,last_seq-60+n,last_change-60+n,'Older fixture '||n,now()-interval '2 minutes' FROM updated,generate_series(1,60) n`,
    [createdChannel, owner.id, 'a'.repeat(64)],
  );
  await call('Page.reload');
  await wait(`!!document.querySelector('[data-conversation-id="${createdChannel}"]')`);
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait("document.querySelector('.message-scroll')?.textContent.includes('Older fixture 60')");
  assert.equal(await js(`!!document.querySelector('${timelineMessage}')`), false);
  await click('Pinned messages');
  await wait(`!!document.querySelector('.chat-feature-panel [data-message-id="${rootMessage}"]')`);
  await click('Jump to original');
  await wait(`document.querySelector('${timelineMessage}')?.dataset.highlighted==='true'`);
  await wait(`(()=>{const target=document.querySelector('${timelineMessage}'),area=document.querySelector('.message-scroll');
    if(!target||!area)return false;const a=area.getBoundingClientRect(),b=target.getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()`);
  await wait("document.querySelector('.chat-tools')?.textContent.includes('History view')");
  await click('Jump to latest messages');
  await wait("document.querySelector('.message-scroll')?.textContent.includes('Older fixture 60')");

  let mediaRequests = 0;
  let mediaFailure: Error | undefined;
  let giphySearches = 0,
    thumbnailRequests = 0;
  const gif = Buffer.from(
    '47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b',
    'hex',
  );
  cdpEvents.set('Fetch.requestPaused', (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('requestId' in value) ||
      typeof value.requestId !== 'string' ||
      !('request' in value) ||
      !value.request ||
      typeof value.request !== 'object' ||
      !('url' in value.request)
    )
      throw new Error('Invalid media interception fixture.');
    const requestId = value.requestId;
    if (
      typeof value.request.url === 'string' &&
      value.request.url.startsWith('https://api.giphy.com/v1/gifs/search?')
    ) {
      giphySearches++;
      void call('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: Buffer.from(JSON.stringify(giphyFixture)).toString('base64'),
      }).catch((error: Error) => {
        mediaFailure = error;
      });
      return;
    }
    if (value.request.url === stillUrl || value.request.url === tenorStillUrl) {
      thumbnailRequests++;
      void call('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/gif' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: Buffer.from(
          'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          'base64',
        ).toString('base64'),
      }).catch((error: Error) => {
        mediaFailure = error;
      });
      return;
    }
    mediaRequests++;
    void (
      value.request.url === mediaUrl
        ? call('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'image/gif' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: gif.toString('base64'),
          })
        : call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    ).catch((error: Error) => {
      mediaFailure = error;
    });
  });
  await call('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://api.giphy.com/*', requestStage: 'Request' },
      { urlPattern: 'https://media.giphy.com/*', requestStage: 'Request' },
      { urlPattern: 'https://i.giphy.com/*', requestStage: 'Request' },
      { urlPattern: 'https://media.tenor.com/*', requestStage: 'Request' },
    ],
  });
  await writeDraft('Preserve my draft');
  await js('document.querySelector(\'button[aria-label="Search GIFs"]\').click()');
  await wait("document.querySelector('.gif-search-panel')?.dataset.open==='true'");
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await wait("document.querySelector('.gif-search-panel')?.dataset.open==='false'");
  await wait("!document.querySelector('.gif-search-panel')");
  assert.equal(
    await js("document.querySelector('textarea[name=message]').value"),
    'Preserve my draft',
  );
  await writeDraft('/gif');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await wait("!!document.querySelector('.gif-search-panel input[type=search]')");
  await js('document.querySelector(\'button[aria-label="Search GIFs"]\').click()');
  await wait("!document.querySelector('.gif-search-panel')");
  await writeDraft('Keep this while sending a GIF');
  await js('document.querySelector(\'button[aria-label="Search GIFs"]\').click()');
  await wait("document.querySelector('.gif-search-panel')?.dataset.open==='true'");
  await js("document.querySelector('textarea[name=message]').focus()");
  await wait("!document.querySelector('.gif-search-panel')");
  await js('document.querySelector(\'button[aria-label="Search GIFs"]\').click()');
  await wait("document.querySelector('.gif-search-panel')?.dataset.open==='true'");
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: 6,
    y: 6,
    button: 'left',
    clickCount: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 6,
    y: 6,
    button: 'left',
    clickCount: 1,
  });
  await wait("!document.querySelector('.gif-search-panel')");
  await js('document.querySelector(\'button[aria-label="Search GIFs"]\').click()');
  await wait("document.querySelector('.gif-search-panel')?.dataset.open==='true'");
  await js(`(()=>{const input=document.querySelector('.gif-search-panel input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'wave');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(giphySearches, 0);
  assert.equal(tenorSearches, 0);
  assert.equal(thumbnailRequests, 0);
  await wait("!!document.querySelector('.gif-search-form button:not(:disabled)')");
  await js("document.querySelector('.gif-search-form').requestSubmit()");
  await wait(
    '!!document.querySelector(\'.gif-search-results button[aria-label="Send GIF: Fixture wave"]\')',
  );
  assert.equal(giphySearches, 1);
  assert.equal(tenorSearches, 0);
  assert.equal(
    await js(
      "!![...document.querySelectorAll('.gif-search-panel [role=tab]')].find(button=>button.textContent==='KLIPY')",
    ),
    true,
    'KLIPY is offered as a separate provider',
  );
  assert.equal(tenorSearches, 0);
  await screenshot('gif-search-composer.png');
  assert.equal(mediaRequests, 0);
  await js(
    'document.querySelector(\'.gif-search-results button[aria-label="Send GIF: Fixture wave"]\').click()',
  );
  await wait("!document.querySelector('.gif-search-panel')");
  assert.equal(
    await js("document.querySelector('textarea[name=message]').value"),
    'Keep this while sending a GIF',
  );
  await writeDraft('');
  const sentGif = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE conversation_id=$1 AND author_id=$2 AND body=$3',
      [createdChannel, user.id, mediaUrl],
    )
  ).rows;
  assert.equal(sentGif.length, 1, 'Selecting a GIF sends one ordinary canonical link message');
  await wait(
    "!![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Load GIF (paused)')",
  );
  assert.equal(mediaRequests, 0);
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await click('Load GIF (paused)');
  await wait(
    "document.querySelector('.gif-canvas')?.width===1 && !document.querySelector('.gif-canvas').hidden",
  );
  assert.equal(mediaFailure, undefined);
  assert.equal(mediaRequests, 1);
  assert.match(
    await js<string>("document.querySelector('.gif-canvas').getAttribute('aria-label')"),
    /paused$/,
  );
  await click('Play GIF');
  await wait(
    "document.querySelector('.gif-canvas')?.getAttribute('aria-label')?.endsWith('playing')",
  );
  assert.equal(
    await js(`new Promise(resolve=>{
    const canvas=document.querySelector('.gif-canvas'),context=canvas.getContext('2d');
    const first=context.getImageData(0,0,1,1).data[0],deadline=performance.now()+2000;
    const inspect=()=>{if(context.getImageData(0,0,1,1).data[0]!==first)resolve(true);
      else if(performance.now()>deadline)resolve(false);else requestAnimationFrame(inspect)};
    requestAnimationFrame(inspect);
  })`),
    true,
    'GIF playback must change actual canvas pixels',
  );
  await click('Pause GIF');
  await wait(
    "document.querySelector('.gif-canvas')?.getAttribute('aria-label')?.endsWith('paused')",
  );
  assert.equal(
    await js(`new Promise(resolve=>requestAnimationFrame(()=>{
    const context=document.querySelector('.gif-canvas').getContext('2d');
    const first=context.getImageData(0,0,1,1).data[0];let frames=0;
    const inspect=()=>{if(context.getImageData(0,0,1,1).data[0]!==first)resolve(false);
      else if(++frames===15)resolve(true);else requestAnimationFrame(inspect)};
    requestAnimationFrame(inspect);
  }))`),
    true,
    'Paused GIF pixels must remain unchanged across animation frames',
  );
  await click('Stop / unload GIF');
  await wait(
    "document.querySelector('.gif-canvas')?.width===0 && document.querySelector('.gif-canvas').hidden",
  );
  assert.equal(await js(`!!document.querySelector('.message-body a[href="${mediaUrl}"]')`), true);
  await call('Fetch.disable');
  cdpEvents.delete('Fetch.requestPaused');
  await call('Emulation.setEmulatedMedia', { features: [] });
  await js(
    "(()=>{const area=document.querySelector('.message-scroll');area.scrollTop=area.scrollHeight})()",
  );
  await wait(`!document.querySelector('[data-conversation-id="${createdChannel}"] .unread-badge')`);
  const beforeResizeRead = (
    await fixture.database.pool.query(
      'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
      [createdChannel, user.id],
    )
  ).rows[0].last_seq;
  const oldViewport = await js<number>("document.querySelector('.message-scroll').clientHeight");
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 520,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait(`document.querySelector('.message-scroll').clientHeight<${oldViewport}`);
  const resizedTop = await js<number>("document.querySelector('.message-scroll').scrollTop");
  const resizedPost = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + createdChannel + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Viewport-resize unread', clientId: randomUUID() },
  });
  assert.equal(resizedPost.statusCode, 200);
  await wait(
    "document.querySelector('.message-scroll')?.textContent.includes('Viewport-resize unread')",
  );
  assert.ok(
    Math.abs(
      (await js<number>("document.querySelector('.message-scroll').scrollTop")) - resizedTop,
    ) <= 1,
  );
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
        [createdChannel, user.id],
      )
    ).rows[0].last_seq,
    beforeResizeRead,
  );
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('Jump to latest messages');
  try {
    await wait(
      `!document.querySelector('[data-conversation-id="${createdChannel}"] .unread-badge')`,
    );
  } catch {
    const reading = await js(`(()=>{const area=document.querySelector('.message-scroll');return {
      visible:document.visibilityState,focused:document.hasFocus(),
      dialogs:[...document.querySelectorAll('[role=dialog]')].map(element=>({label:element.getAttribute('aria-label'),inert:element.inert})),
      scroll:{height:area.scrollHeight,top:area.scrollTop,viewport:area.clientHeight},
      history:document.querySelector('.chat-tools')?.textContent,
      loading:!!document.querySelector('.message-scroll [role=status]'),
      error:document.querySelector('.chat-timeline > .notice')?.textContent,
      cursor:document.querySelector('[data-conversation-id="${createdChannel}"] .unread-badge')?.textContent
    }})()`);
    throw new Error(
      'Latest reading did not acknowledge visible content: ' + JSON.stringify(reading),
    );
  }

  await writeDraft('@general');
  await wait(`!!document.querySelector('#mention-option-channel-${general}')`);
  await js(`document.querySelector('#mention-option-channel-${general}').click()`);
  await wait("document.querySelector('textarea[name=message]').value==='#general '");
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await wait("document.querySelector('textarea[name=message]').value===''");
  const textReference = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE conversation_id=$1 AND body=$2',
      [createdChannel, '<#' + general + '> '],
    )
  ).rows[0];
  assert.ok(textReference, 'Selected channel labels must become stable server-side IDs');
  await wait(
    `!!document.querySelector('[data-message-id="${textReference.id}"] button[aria-label="Open text channel general"]')`,
  );
  await js(
    `document.querySelector('[data-message-id="${textReference.id}"] button[aria-label="Open text channel general"]').click()`,
  );
  await wait("document.querySelector('.channel-header strong')?.textContent==='general'");
  await js(`document.querySelector('[data-conversation-id="${createdChannel}"]').click()`);
  await wait(
    "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
  );
  const referencedVoice = (
    await fixture.database.pool.query(
      'SELECT id,name FROM voice_channels ORDER BY created_at,id LIMIT 1',
    )
  ).rows[0];
  let automaticJoins = 0;
  cdpEvents.set('Network.requestWillBeSent', (value) => {
    if (
      value &&
      typeof value === 'object' &&
      'request' in value &&
      value.request &&
      typeof value.request === 'object' &&
      'url' in value.request &&
      typeof value.request.url === 'string' &&
      value.request.url.endsWith('/api/voice/join')
    )
      automaticJoins++;
  });
  await call('Network.enable');
  await writeDraft('@' + referencedVoice.name);
  await wait(`!!document.querySelector('#mention-option-voice-${referencedVoice.id}')`);
  await js(`document.querySelector('#mention-option-voice-${referencedVoice.id}').click()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await wait("document.querySelector('textarea[name=message]').value===''");
  const voiceReference = (
    await fixture.database.pool.query(
      'SELECT id FROM messages WHERE conversation_id=$1 AND body=$2',
      [createdChannel, '<voice:' + referencedVoice.id + '> '],
    )
  ).rows[0];
  assert.ok(voiceReference);
  await wait(
    `!!document.querySelector('[data-message-id="${voiceReference.id}"] .channel-reference')`,
  );
  await js(
    `document.querySelector('[data-message-id="${voiceReference.id}"] .channel-reference').click()`,
  );
  await wait("!!document.querySelector('.voice-panel .voice-controls')");
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(automaticJoins, 0, 'Voice references must not join or capture media');
  cdpEvents.delete('Network.requestWillBeSent');
  await js("document.querySelector('.voice-settings-toggle').click()");

  await js('document.querySelector(\'button[aria-label="New direct message"]\').click()');
  await wait("!!document.querySelector('select[name=userId]')");
  await js("document.querySelector('select[name=userId]').value=" + JSON.stringify(owner.id));
  await click('Open conversation');
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await wait("document.querySelector('button[aria-pressed=true]')?.textContent==='Participants'");
  await click('Community');
  await wait("document.querySelector('button[aria-pressed=true]')?.textContent==='Community'");
  await click('Participants');
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
  await reload();
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
  const backgroundResponse = await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'While unfocused', clientId: randomUUID() },
  });
  assert.equal(backgroundResponse.statusCode, 200);
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
  await notificationSettings();
  await js(`window.soundCalls=[];window.nativeSoundPlay=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=async function(){
      if(this.dataset.appSound && window.denySounds) throw new DOMException('Test playback denied','NotAllowedError');
      await window.nativeSoundPlay.call(this);
      if(this.dataset.appSound)window.soundCalls.push({kind:this.dataset.appSound,sink:this.sinkId,volume:this.volume,at:Date.now()});
    }`);
  await click('Enable notifications');
  await js('document.querySelector(\'input[aria-label="Notification popups"]\').click()');
  await wait('document.querySelector(\'input[aria-label="Notification popups"]\').checked');
  await wait(
    "document.querySelector('.notification-settings button')?.getAttribute('aria-pressed')==='true'",
  );
  await closeSettings();
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  await js("document.hasFocus=()=>false; window.dispatchEvent(new Event('blur'))");
  const alertResponse = await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Secret alert body @' + username, clientId: randomUUID() },
  });
  assert.equal(alertResponse.statusCode, 200);
  try {
    await wait('window.notificationCalls.length===1');
  } catch {
    const diagnostics = await js(`({
      count:window.notificationCalls.length,
      visible:document.visibilityState,focused:document.hasFocus(),locks:typeof navigator.locks?.request,
      toast:!!document.querySelector('.notification-toast'),
      error:document.querySelector('.notification-settings [role=alert]')?.textContent,
      controls:[...document.querySelectorAll('.notification-settings input[type=checkbox]')].map(input=>({label:input.getAttribute('aria-label'),checked:input.checked})),
      enabled:document.querySelector('.notification-settings button')?.getAttribute('aria-pressed')
    })`);
    throw new Error('Notification delivery failed: ' + JSON.stringify(diagnostics));
  }
  assert.equal(await js('window.soundCalls.length'), 0, 'Popup opt-in must not enable sound');
  assert.equal(await js('window.notificationCalls[0].options.silent'), true);
  assert.equal(
    await js('window.notificationCalls[0].options.body'),
    'New activity. Open Rajcord to read it.',
  );
  await js("delete document.hasFocus;window.dispatchEvent(new Event('focus'))");
  await js('window.notificationCalls[0].onclick()');
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await js(
    `document.querySelector('[data-conversation-id="${general}"]').click(); document.hasFocus=()=>false; window.dispatchEvent(new Event('blur'))`,
  );
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  const marker = 'rajcord-test-popup:';
  await js(`window.Notification=class extends window.Notification {
    constructor(...args){super(...args);localStorage.setItem('${marker}'+crypto.randomUUID(),'1')}
  }`);
  const secondTarget = await call<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    background: true,
  });
  const attached = await call<{ sessionId: string }>('Target.attachToTarget', {
    targetId: secondTarget.targetId,
    flatten: true,
  });
  await call('Page.enable', {}, attached.sessionId);
  await call('Runtime.enable', {}, attached.sessionId);
  await call(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `
    document.hasFocus=()=>false;window.notificationCalls=[];
    window.Notification=class {
      static permission='granted';static requestPermission(){return Promise.resolve('granted')}
      constructor(title,options){this.title=title;this.options=options;window.notificationCalls.push(this);localStorage.setItem('${marker}'+crypto.randomUUID(),'1')}
      close(){this.onclose?.()}
    };
  `,
    },
    attached.sessionId,
  );
  await call('Page.navigate', { url: origin }, attached.sessionId);
  await waitCondition(
    () =>
      tabJs(
        attached.sessionId,
        "!!document.querySelector('[data-connection=connected]') && Object.keys(localStorage).some(key=>key.startsWith('tricord-notification-device-v2:') && JSON.parse(localStorage.getItem(key)).enabled===true)",
      ),
    'second authenticated tab ready',
  );
  assert.equal(
    await tabJs(
      attached.sessionId,
      "Array.isArray(window.notificationCalls) && Notification.permission==='granted' && !document.hasFocus()",
    ),
    true,
    'Second-tab notification/focus adapters must be installed before delivery',
  );
  const noticeFrames = new Map<string, number>();
  cdpEvents.set('Network.webSocketFrameReceived', (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('response' in value) ||
      !value.response ||
      typeof value.response !== 'object' ||
      !('payloadData' in value.response) ||
      typeof value.response.payloadData !== 'string' ||
      !value.response.payloadData.startsWith('42[')
    )
      return;
    const event: unknown = JSON.parse(value.response.payloadData.slice(2));
    if (
      Array.isArray(event) &&
      event[0] === 'message:created' &&
      event[1] &&
      typeof event[1] === 'object' &&
      typeof event[1].messageId === 'string'
    ) {
      noticeFrames.set(event[1].messageId, (noticeFrames.get(event[1].messageId) ?? 0) + 1);
    }
  });
  await call('Network.enable');
  await call('Network.enable', {}, attached.sessionId);
  const crossTab = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + dm.id + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Coordinated cross-tab alert', clientId: randomUUID() },
  });
  assert.equal(crossTab.statusCode, 200);
  await waitCondition(
    async () => noticeFrames.get(crossTab.json().message.id) === 2,
    'both tabs receive the same authenticated notice',
  );
  try {
    await waitCondition(
      () => js(`Object.keys(localStorage).filter(key=>key.startsWith('${marker}')).length>=1`),
      'one cooperating tab completes popup delivery',
    );
  } catch {
    const snapshot = `(async()=>({
      count:Array.isArray(window.notificationCalls)?window.notificationCalls.length:'mock missing',
      permission:window.Notification?.permission,
      visible:document.visibilityState,focused:document.hasFocus(),
      toast:!!document.querySelector('.notification-toast'),
      error:document.querySelector('.notification-settings [role=alert]')?.textContent,
      enabled:document.querySelector('.notification-settings button')?.getAttribute('aria-pressed'),
      popup:document.querySelector('input[aria-label="Notification popups"]')?.checked,
      status:document.querySelector('.notification-settings [role=status]')?.textContent,
      popup:document.querySelector('input[aria-label="Notification popups"]')?.checked,
      status:document.querySelector('.notification-settings [role=status]')?.textContent,
      peers:JSON.parse(localStorage.getItem(${JSON.stringify(coordinationKey)})||'null')?.peers,
      seen:JSON.parse(localStorage.getItem(${JSON.stringify(coordinationKey)})||'null')?.seen?.slice(-3),
      locks:await navigator.locks.query()
    }))()`;
    throw new Error(
      'Cooperating delivery failed: ' +
        JSON.stringify({
          primary: await js(snapshot),
          secondary: await tabJs(attached.sessionId, snapshot),
        }),
    );
  }
  await Promise.all([
    js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),
    tabJs(
      attached.sessionId,
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    ),
  ]);
  await waitCondition(
    () =>
      js('navigator.locks.query().then(state=>state.pending.length===0 && state.held.length===2)'),
    'notification claims settled with two live documents',
  );
  assert.equal(
    await js(`Object.keys(localStorage).filter(key=>key.startsWith('${marker}')).length`),
    1,
  );
  cdpEvents.delete('Network.webSocketFrameReceived');
  await call('Target.closeTarget', { targetId: secondTarget.targetId });
  await js(
    `for(const key of Object.keys(localStorage))if(key.startsWith('${marker}'))localStorage.removeItem(key);delete document.hasFocus;window.dispatchEvent(new Event('focus'))`,
  );
  await js(`document.querySelector('[data-conversation-id="${dm.id}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await notificationSettings();
  await js(`window.notificationSoundStarts=0;
    const create=AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator=function(){
      const oscillator=create.call(this),start=oscillator.start.bind(oscillator);
      oscillator.start=(...args)=>{window.notificationSoundStarts++;return start(...args)};
      return oscillator;
    }`);
  assert.equal(
    await js('document.querySelector(\'input[aria-label="Notification sound"]\').checked'),
    false,
  );
  assert.equal(await js('window.notificationSoundStarts'), 0);
  await js('document.querySelector(\'input[aria-label="Notification sound"]\').click()');
  await wait(
    "!![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Enable / test sound' && !button.disabled)",
  );
  await call('Runtime.evaluate', {
    expression:
      "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Enable / test sound').click()",
    userGesture: true,
    awaitPromise: true,
  });
  await wait('window.notificationSoundStarts===1');
  await js(`(()=>{const input=document.querySelector('.notification-settings input[type="range"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.25');
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(
    `JSON.parse(localStorage.getItem('tricord-notification-device-v2:${user.id}')).volume===0.25`,
  );
  async function mode(value: string) {
    await wait(
      "!!document.querySelector('.notification-settings select') && !document.querySelector('.notification-settings select').disabled",
    );
    await js(
      `(()=>{const input=document.querySelector('.notification-settings select');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await waitCondition(async () => {
      const row = (
        await fixture.database.pool.query(
          'SELECT mode FROM conversation_alert_preferences WHERE user_id=$1 AND conversation_id=$2',
          [user.id, dm.id],
        )
      ).rows[0];
      return value === 'default' ? !row : row?.mode === value;
    }, 'account-private conversation mode persisted');
  }
  await mode('muted');
  await screenshot('notification-settings-desktop.png');
  await closeSettings();
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  const mutedNative = await js<number>('window.notificationCalls.length');
  const mutedSound = await js<number>('window.notificationSoundStarts');
  const mutedPost = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + dm.id + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Muted conversation still counts unread', clientId: randomUUID() },
  });
  assert.equal(mutedPost.statusCode, 200);
  await wait(badge);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await js('window.notificationCalls.length'), mutedNative);
  assert.equal(await js('window.notificationSoundStarts'), mutedSound);
  await js(`document.querySelector('[data-conversation-id="${dm.id}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='Browser owner'");
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await notificationSettings();
  await mode('default');
  for (const prefix of ['Mute alerts from ', 'Prioritize alerts from ']) {
    await wait(
      `!![...document.querySelectorAll('.notification-sender')].find(row=>row.textContent.includes(${JSON.stringify('@' + owner.username)}))`,
    );
    await wait(`(()=>{const row=[...document.querySelectorAll('.notification-sender')].find(row=>row.textContent.includes(${JSON.stringify('@' + owner.username)}));
      const input=[...row.querySelectorAll('input')].find(input=>input.getAttribute('aria-label')?.startsWith(${JSON.stringify(prefix)}));return !!input&&!input.disabled})()`);
    await js(`(()=>{const row=[...document.querySelectorAll('.notification-sender')].find(row=>row.textContent.includes(${JSON.stringify('@' + owner.username)}));
      const input=[...row.querySelectorAll('input')].find(input=>input.getAttribute('aria-label')?.startsWith(${JSON.stringify(prefix)}));input.click()})()`);
    await waitCondition(async () => {
      const row = (
        await fixture.database.pool.query(
          'SELECT muted,priority FROM sender_alert_preferences WHERE user_id=$1 AND sender_id=$2',
          [user.id, owner.id],
        )
      ).rows[0];
      return !!row?.muted && (prefix.startsWith('Prioritize') ? !!row.priority : true);
    }, 'account-private sender preference persisted');
  }
  await closeSettings();
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  const senderMuted = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + dm.id + '/messages',
    headers: ownerHeaders,
    payload: { body: 'Priority never overrides sender mute', clientId: randomUUID() },
  });
  assert.equal(senderMuted.statusCode, 200);
  await wait(badge);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await js('window.notificationCalls.length'), mutedNative);
  assert.equal(await js('window.notificationSoundStarts'), mutedSound);
  await js(`document.querySelector('[data-conversation-id="${dm.id}"]').click()`);
  await wait(`!document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')`);
  await notificationSettings();
  await wait(`(()=>{const row=[...document.querySelectorAll('.notification-sender')].find(row=>row.textContent.includes(${JSON.stringify('@' + owner.username)}));
    const input=row&&[...row.querySelectorAll('input')].find(input=>input.getAttribute('aria-label')?.startsWith('Mute alerts from '));return !!input&&!input.disabled&&input.checked})()`);
  await js(`(()=>{const row=[...document.querySelectorAll('.notification-sender')].find(row=>row.textContent.includes(${JSON.stringify('@' + owner.username)}));
    [...row.querySelectorAll('input')].find(input=>input.getAttribute('aria-label')?.startsWith('Mute alerts from ')).click()})()`);
  await waitCondition(async () => {
    const row = (
      await fixture.database.pool.query(
        'SELECT muted,priority FROM sender_alert_preferences WHERE user_id=$1 AND sender_id=$2',
        [user.id, owner.id],
      )
    ).rows[0];
    return !!row && !row.muted && row.priority;
  }, 'priority remains private without bypassing global disable');
  await closeSettings();
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  const beforeThreadNoticeRead =
    (
      await fixture.database.pool.query(
        'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
        [createdChannel, user.id],
      )
    ).rows[0]?.last_seq ?? '0';
  const foregroundNative = await js<number>('window.notificationCalls.length');
  const foregroundSound = await js<number>('window.notificationSoundStarts');
  const foregroundReply = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + createdChannel + '/messages',
    headers: ownerHeaders,
    payload: {
      body: 'Public reply alert without mention',
      replyToId: rootMessage,
      clientId: randomUUID(),
    },
  });
  assert.equal(foregroundReply.statusCode, 200);
  await wait("!!document.querySelector('.notification-toast')");
  await wait(`window.notificationSoundStarts===${foregroundSound + 1}`);
  assert.equal(await js('window.notificationCalls.length'), foregroundNative);
  await js(`(()=>{const toast=document.querySelector('.notification-toast');
    const open=[...toast.querySelectorAll('button')].find(button=>/open/i.test(button.textContent+' '+button.getAttribute('aria-label')));
    if(open)open.click();else if(toast instanceof HTMLButtonElement)toast.click();else throw new Error('Toast open control missing')})()`);
  await wait(
    "document.querySelector('.channel-header strong')?.textContent==='Café 🎮 Club renamed'",
  );
  await wait(
    "document.querySelector('.chat-feature-panel')?.textContent.includes('Public reply alert without mention')",
  );
  assert.equal(
    (
      await fixture.database.pool.query(
        'SELECT last_seq FROM conversation_reads WHERE conversation_id=$1 AND user_id=$2',
        [createdChannel, user.id],
      )
    ).rows[0]?.last_seq ?? '0',
    beforeThreadNoticeRead,
  );
  const beforeDisabled = await js<number>('window.notificationCalls.length');
  const soundBeforeDisabled = await js<number>('window.notificationSoundStarts');
  await notificationSettings();
  await click('Disable notifications');
  await wait(
    "document.querySelector('.notification-settings button')?.getAttribute('aria-pressed')==='false'",
  );
  await closeSettings();
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  await wait("document.querySelector('.channel-header strong')?.innerText==='general'");
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Disabled alert', clientId: randomUUID() },
  });
  await wait(badge);
  assert.equal(await js('window.notificationCalls.length'), beforeDisabled);
  assert.equal(await js('window.notificationSoundStarts'), soundBeforeDisabled);

  await js("document.querySelector('.sound-settings').open=true");
  await click('Enable sounds');
  await click('Preview sound');
  await wait("document.querySelector('.sound-settings').innerText.includes('Choose speakers')");
  await js("document.querySelector('.voice-settings-toggle').click()");
  await click('Find audio devices');
  await wait('document.querySelector(\'select[aria-label="Voice speakers"]\').options.length>1');
  await js(
    `(()=>{const s=document.querySelector('select[aria-label="Voice speakers"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await click('Preview sound');
  await wait('window.soundCalls.length===1');
  assert.ok(await js('window.soundCalls[0].sink.length>0'));
  await js(
    `(()=>{const s=document.querySelector('input[aria-label="Application sound volume"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'0.2');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await wait('Date.now()-window.soundCalls.at(-1).at>=300');
  await click('Preview sound');
  await wait('window.soundCalls.length===2');
  assert.equal(await js('window.soundCalls[1].volume'), 0.2);
  assert.equal(
    await js('window.notificationCalls.length'),
    beforeDisabled,
    'Voice sounds must not enable popups',
  );
  await js(`document.querySelector('[data-conversation-id="${general}"]').click()`);
  const unreadBeforeAlert = await js<number>(
    `Number(document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')?.textContent || '0')`,
  );
  await app.inject({
    url: '/api/conversations/' + dm.id + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Message alerts leave voice sounds alone', clientId: randomUUID() },
  });
  await wait(
    `Number(document.querySelector('[data-conversation-id="${dm.id}"] .unread-badge')?.textContent || '0')===${unreadBeforeAlert + 1}`,
  );
  assert.equal(
    await js('window.soundCalls.length'),
    2,
    'Message alerts use the notification settings, not the voice-sound player',
  );
  await js('window.denySounds=true');
  await click('Preview sound');
  await wait(
    "document.querySelector('.sound-settings').innerText.includes('Sound playback blocked')",
  );
  await js('window.denySounds=false');
  await click('Preview sound');
  await wait('window.soundCalls.length===3');
  await click('Disable sounds');
  await wait("!document.querySelector('audio[data-app-sound]')");
  assert.equal(await js('window.soundCalls.length'), 3);
  await reload();
  await wait("!!document.querySelector('[data-connection=connected]')");
  await wait(
    "document.querySelector('.sound-settings button')?.textContent.trim()==='Enable sounds'",
  );
  assert.equal(
    await js('document.querySelector(\'input[aria-label="Application sound volume"]\').value'),
    '0.2',
  );
  assert.equal(await js("!!document.querySelector('audio[data-app-sound]')"), false);
  await js("document.querySelector('.sound-settings summary').focus()");
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  });
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
  await wait("document.querySelector('.sound-settings').open");
  assert.equal(
    await js(
      "document.querySelector('.sidebar').scrollWidth<=document.querySelector('.sidebar').clientWidth",
    ),
    true,
  );
  await screenshot('sounds-browser-controls.png');

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
  assert.equal(mediaRequests, 1);
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await js(
    "document.querySelector('button[aria-label=Members]').focus();document.querySelector('button[aria-label=Members]').click()",
  );
  await wait("!!document.querySelector('[role=dialog][aria-label=Members]')");
  assert.equal(
    await js("!!document.activeElement.closest('[role=dialog][aria-label=Members]')"),
    true,
  );
  await app.inject({
    url: '/api/conversations/' + groupId + '/messages',
    method: 'POST',
    headers: ownerHeaders,
    payload: { body: 'Hidden by member drawer', clientId: randomUUID() },
  });
  const drawerBadge = `document.querySelector('[data-conversation-id="${groupId}"] .unread-badge')`;
  await wait(`!!${drawerBadge}`);
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await wait("!document.querySelector('[role=dialog][aria-label=Members]')");
  assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Members');
  await wait(`!${drawerBadge}`);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('messaging-browser-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await reload();
  await wait(
    "[...document.querySelectorAll('.channels button')].some(b=>b.innerText.includes('Browser invitation group'))",
  );
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
          'secure hyperlinks in sent, stored, received and edited messages',
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
          'application sounds off by default and independent of popups',
          'exact selected sound sink and preview',
          'sound volume and idempotent message delivery',
          'focused conversation sound suppression',
          'denied sound playback and explicit recovery',
          'sound preferences survive reload without autoplay',
          'sound controls keyboard access and sidebar layout',
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
  await reload();
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
          'Unicode channel names, topics and shared ordering',
          'category create, rename and non-destructive removal',
          'stale metadata edits preserve unsaved input',
          'archive, restore and reload persistence',
          'channel dialog keyboard focus and narrow layout',
        ],
        profile,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: Browser authentication, messaging/unread/notifications, voice sounds, channel/category management and live multi-connection presence, scoped views and drawer keyboard/focus in the configured headless Chromium browser.',
  );
} finally {
  for (const peer of presencePeers) peer.disconnect();
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
