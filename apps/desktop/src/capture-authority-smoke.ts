import { app, BrowserWindow, session, type Session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionCaptureAuthority } from './capture-authority-http.js';
import { installNativeCapture } from './native-capture.js';
import { openScreenPicker } from './screen-picker.js';
import { trustedAudioCheck, trustedAudioRequest } from './media-permissions.js';

const profile = process.argv
  .find((arg) => arg.startsWith('--authority-profile='))
  ?.slice('--authority-profile='.length);
const ownedRoot = path.resolve(__dirname, '../../../.local');
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== ownedRoot ||
  !path.basename(profile).startsWith('screen-authority-smoke-')
)
  throw new Error('Owned authority fixture profile required');
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let sequence = 0;
const replies = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
process.on('message', (message: unknown) => {
  const reply = message as { id?: number; value?: unknown; error?: string };
  const pending = replies.get(reply?.id ?? -1);
  if (!pending) return;
  replies.delete(reply.id!);
  if (reply.error) pending.reject(new Error(reply.error));
  else pending.resolve(reply.value);
});
function rpc<T = Record<string, never>>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  assert.ok(process.send, 'Owned parent IPC required');
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    replies.set(id, { resolve: (value) => resolve(value as T), reject });
    process.send!({ id, action, args });
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function wait(work: () => boolean | Promise<boolean>, label: string, attempts = 240) {
  for (let index = 0; index < attempts; index++) {
    if (await work()) return;
    await delay(25);
  }
  throw new Error('Fixture wait failed: ' + label);
}
type Config = { origin: string; username: string; password: string; channelId: string };
const checks: string[] = [];
function check(value: unknown, label: string) {
  assert.ok(value, label);
  checks.push(label);
}
const capture =
  "window.fixtureResult='pending';navigator.mediaDevices.getDisplayMedia({video:true,audio:false}).then(stream=>{window.fixtureStream=stream;window.fixtureResult='live'},()=>{window.fixtureResult='denied'});void 0";

async function fixture(kind: string) {
  const config = await rpc<Config>('begin', { pending: kind === 'pending' });
  assert.equal(config.origin, 'http://127.0.0.1:3006');
  const isolated = session.fromPartition('authority-native-' + randomUUID());
  const nativeFetch = isolated.fetch.bind(isolated);
  const pending = new Set<Promise<unknown>>();
  const trace: { path: string; status?: number }[] = [];
  const allowed = new Set([
    '/api/auth/me',
    ...[
      'prepare',
      'check',
      'consume',
      'cancel',
      'handoff',
      'publication-check',
      'publication-cancel',
    ].map((action) => '/api/screen/capture/' + action),
  ]);
  let holdCancellation = false;
  const cancellation = deferred(),
    cancelling = deferred();
  isolated.fetch = async (input, options) => {
    assert.equal(typeof input, 'string');
    const url = new URL(input as string);
    assert.equal(url.origin, config.origin);
    assert.ok(allowed.has(url.pathname), 'Authority only uses fixed paths');
    assert.equal(options?.credentials, 'include');
    assert.equal(options?.redirect, 'error');
    if (options?.method === 'POST')
      assert.equal(new Headers(options.headers).get('origin'), config.origin);
    const item = { path: url.pathname, status: undefined as number | undefined };
    trace.push(item);
    const request = nativeFetch(input, options);
    pending.add(request);
    try {
      const response = await request;
      item.status = response.status;
      // Observe owned reader disposal without replacing network responses or authorization.
      if (response.body) {
        const body = response.body,
          finished = deferred();
        pending.add(finished.promise);
        const getReader = body.getReader.bind(body);
        body.getReader = (() => {
          const reader = getReader();
          const cancel = reader.cancel.bind(reader),
            release = reader.releaseLock.bind(reader);
          reader.cancel = async (reason) => {
            await cancel(reason);
            if (holdCancellation) {
              cancelling.resolve();
              await cancellation.promise;
            }
          };
          reader.releaseLock = () => {
            release();
            pending.delete(finished.promise);
            finished.resolve();
          };
          return reader;
        }) as typeof body.getReader;
      }
      return response;
    } finally {
      pending.delete(request);
    }
  };
  const owner = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const source = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  source.webContents.on('paint', () => {});
  await source.loadURL(config.origin + '/fixture/source');
  await owner.loadURL(config.origin + '/fixture/requester');
  const shutdown = new EventEmitter();
  const beforeCookies = isolated.cookies.listenerCount('changed');
  const beforeNavigation = owner.webContents.listenerCount('did-start-navigation');
  const errors: string[] = [];
  const authority = createSessionCaptureAuthority({
    owner,
    session: isolated,
    origin: config.origin,
    context: () => boundary.context(),
    shutdown,
    onError: (code) => errors.push(code),
  });
  let requestHandler!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let checkHandler!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  const setRequest = isolated.setPermissionRequestHandler.bind(isolated),
    setCheck = isolated.setPermissionCheckHandler.bind(isolated);
  isolated.setPermissionRequestHandler = (handler) => {
    assert.ok(handler);
    requestHandler = handler;
    setRequest(handler);
  };
  isolated.setPermissionCheckHandler = (handler) => {
    assert.ok(handler);
    checkHandler = handler;
    setCheck(handler);
  };
  let picker: BrowserWindow | undefined,
    enumerations = 0;
  const boundary: ReturnType<typeof installNativeCapture> = installNativeCapture({
    owner,
    session: isolated,
    targetOrigin: config.origin,
    enabled: kind === 'disabled' ? undefined : true,
    qualification: 'synthetic-webcontents',
    authority,
    shutdown,
    permissions: {
      request: (_wc, permission, callback, details) =>
        callback(
          trustedAudioRequest(
            config.origin,
            details.requestingUrl,
            details.isMainFrame,
            permission,
            'mediaTypes' in details ? details.mediaTypes : undefined,
          ),
        ),
      check: (_wc, permission, origin, details) =>
        trustedAudioCheck(
          config.origin,
          origin,
          details.isMainFrame,
          permission,
          details.mediaType,
        ),
    },
    enumerate: async () => {
      enumerations++;
      return [
        { id: 'window:100:0', name: 'Owned synthetic video', video: source.webContents.mainFrame },
      ];
    },
    openPicker: async (_snapshot, signal, policy) => {
      const port = await openScreenPicker({ owner, signal, policy, visible: false });
      picker = BrowserWindow.fromWebContents(port.inspect()!.webContents as WebContents)!;
      return port;
    },
    onError: (code) => errors.push(code),
  });
  isolated.setPermissionRequestHandler = setRequest;
  isolated.setPermissionCheckHandler = setCheck;
  const js = <T = unknown>(script: string, gesture = false): Promise<T> =>
    owner.webContents.executeJavaScript(script, gesture);
  async function request(route: string, body?: unknown, csrf?: string, origin = config.origin) {
    const response = await nativeFetch(config.origin + route, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      redirect: 'error',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    return { status: response.status, value: value as { csrfToken: string; id: string } };
  }
  let csrf = '';
  let screenEpoch: string = randomUUID();
  async function login() {
    const response = await request('/api/auth/login', {
      username: config.username,
      password: config.password,
      remember: false,
    });
    assert.equal(response.status, 200);
    csrf = response.value.csrfToken;
    const cookies = await isolated.cookies.get({ url: config.origin, name: 'tricord_session' });
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0]!.httpOnly, true);
    assert.equal(await js("document.cookie.includes('tricord_session')"), false);
  }
  async function join() {
    const response = await request('/api/voice/join', { channelId: config.channelId }, csrf);
    assert.equal(response.status, 200);
    screenEpoch = (await rpc<{ epoch: string }>('bind-screen')).epoch;
  }
  async function choose() {
    await wait(
      async () =>
        !!picker &&
        !picker.isDestroyed() &&
        (await picker.webContents.executeJavaScript(
          "document.querySelectorAll('.source').length===1",
        )),
      'owned picker',
    );
    await picker!.webContents.executeJavaScript(
      "document.querySelector('.source').click();document.querySelector('input[value=none]').click();document.getElementById('confirm').click()",
      true,
    );
  }
  async function drain() {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const work = [...pending];
      if (!work.length) return;
      await Promise.allSettled(work);
    }
  }
  return {
    config,
    owner,
    isolated,
    authority,
    boundary,
    trace,
    errors,
    js,
    request,
    login,
    join,
    choose,
    drain,
    csrf: () => csrf,
    epoch: () => screenEpoch,
    start: (gesture = true) => js(capture, gesture),
    denied: () =>
      wait(
        async () => await js("window.fixtureResult==='denied'&&!window.fixtureStream"),
        'denied without tracks',
      ),
    live: () => wait(async () => await js("window.fixtureResult==='live'"), 'live owned video'),
    enumerations: () => enumerations,
    holdCancellation: () => {
      holdCancellation = true;
    },
    cancellationStarted: cancelling.promise,
    releaseCancellation: () => {
      holdCancellation = false;
      cancellation.resolve();
    },
    probePermissions: () => {
      const details = { requestingUrl: owner.webContents.mainFrame.url, isMainFrame: true };
      let microphone = false,
        camera = true;
      requestHandler(
        owner.webContents,
        'media',
        (value) => {
          microphone = value;
        },
        { ...details, mediaTypes: ['audio'] } as Parameters<typeof requestHandler>[3],
      );
      requestHandler(
        owner.webContents,
        'media',
        (value) => {
          camera = value;
        },
        { ...details, mediaTypes: ['video'] } as Parameters<typeof requestHandler>[3],
      );
      check(
        microphone &&
          !camera &&
          checkHandler(
            owner.webContents,
            'speaker-selection',
            config.origin,
            details as Parameters<typeof checkHandler>[3],
          ),
        'installed handlers preserve microphone/speaker delegation and camera denial without opening devices',
      );
    },
    close: async () => {
      cancellation.resolve();
      holdCancellation = false;
      await authority.dispose();
      await rpc('release');
      await drain();
      if (!owner.isDestroyed())
        await js('window.fixtureStream?.getTracks().forEach(track=>track.stop())');
      boundary.dispose();
      assert.equal(isolated.cookies.listenerCount('changed'), beforeCookies);
      assert.equal(owner.webContents.listenerCount('did-start-navigation'), beforeNavigation);
      assert.equal(shutdown.eventNames().length, 0);
      if (picker && !picker.isDestroyed()) picker.destroy();
      owner.destroy();
      source.destroy();
      isolated.fetch = nativeFetch;
      await isolated.closeAllConnections();
      await session.defaultSession.closeAllConnections();
      await isolated.clearStorageData();
      assert.equal(pending.size, 0);
      await rpc('end');
    },
  };
}

async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  for (const kind of ['no-session', 'pending', 'no-lease', 'other-session', 'disabled']) {
    const f = await fixture(kind);
    try {
      if (kind !== 'no-session') await f.login();
      if (kind === 'other-session' || kind === 'disabled') await f.join();
      if (kind === 'other-session') {
        await f.isolated.cookies.remove(f.config.origin, 'tricord_session');
        await f.login();
      }
      if (kind === 'disabled') await f.authority.prepare('none', f.epoch());
      else await assert.rejects(f.authority.prepare('none', f.epoch()));
      if (kind === 'no-session')
        check(
          f.trace.some((item) => item.status === 401),
          'real API rejects missing session',
        );
      if (kind === 'pending')
        check(
          (
            await f.request(
              '/api/screen/capture/prepare',
              { requestId: randomUUID(), sound: 'none', epoch: randomUUID() },
              f.csrf(),
            )
          ).status === 403,
          'real API rejects pending account',
        );
      if (kind === 'no-lease' || kind === 'other-session')
        check(
          f.trace.some((item) => item.path.endsWith('/prepare') && item.status === 403),
          kind + ' is rejected by the real exact-session lease check',
        );
      await f.start();
      await f.denied();
      check(f.enumerations() === 0, kind + ' denies capture before source access');
    } finally {
      await f.close();
    }
  }
  const happy = await fixture('happy');
  try {
    await happy.login();
    await happy.join();
    check(
      await happy.js(
        "typeof require==='undefined'&&typeof process==='undefined'&&!window.tricordDesktop",
      ),
      'remote fixture has no Node, app bridge or fixture-control capability',
    );
    check(
      (
        await happy.request(
          '/api/screen/capture/prepare',
          { requestId: randomUUID(), sound: 'none', epoch: randomUUID() },
          'invalid',
        )
      ).status === 403,
      'real HTTP capture authorization rejects incorrect CSRF',
    );
    await assert.rejects(
      happy.request(
        '/api/screen/capture/prepare',
        { requestId: randomUUID(), sound: 'none', epoch: randomUUID() },
        happy.csrf(),
        'https://foreign.example',
      ),
    );
    check(true, 'real native HTTP boundary rejects foreign origin');
    await happy.authority.prepare('none', happy.epoch());
    happy.probePermissions();
    await happy.start(false);
    await happy.denied();
    check(happy.enumerations() === 0, 'native request without gesture is denied');
    const child = happy.owner.webContents.mainFrame.frames[0]!;
    await child.executeJavaScript(capture, true);
    await wait(
      async () =>
        (await child.executeJavaScript(
          "window.fixtureResult==='denied'&&!window.fixtureStream",
        )) === true,
      'child denial',
    );
    check(happy.enumerations() === 0, 'native child frame cannot use the armed main intent');
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        session: happy.isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await foreign.loadURL(happy.config.origin + '/fixture/foreign');
      await foreign.webContents.executeJavaScript(capture, true);
      await wait(
        async () =>
          await foreign.webContents.executeJavaScript(
            "window.fixtureResult==='denied'&&!window.fixtureStream",
          ),
        'foreign denial',
      );
      check(happy.enumerations() === 0, 'same-session foreign native frame cannot use intent');
    } finally {
      foreign.destroy();
    }
    await happy.start();
    await happy.choose();
    await happy.live();
    check(
      await happy.js(
        "window.fixtureStream.getVideoTracks().length===1&&window.fixtureStream.getVideoTracks()[0].readyState==='live'&&window.fixtureStream.getAudioTracks().length===0",
      ),
      'real cookie/API authority grants only the consented owned video',
    );
    const state = await rpc<{ consumes: number[] }>('state');
    check(
      state.consumes.length === 1 && state.consumes[0] === 200,
      'native success requires one real successful server consume',
    );
    check(
      happy.trace.some((item) => item.path.endsWith('/consume') && item.status === 200),
      'actual Session.fetch carries consume over HTTP',
    );
    await happy.js(
      'window.fixtureStream.getTracks().forEach(track=>track.stop());delete window.fixtureStream',
    );
    await happy.start();
    await happy.denied();
    check(happy.enumerations() === 2, 'consumed native intent cannot be replayed');
  } finally {
    await happy.close();
  }

  for (const kind of [
    'csrf',
    'revoke',
    'logout',
    'expire',
    'replace-lease',
    'session-replacement',
    'navigation',
    'cancel',
    'late-response',
    'grant-expiry',
  ]) {
    const f = await fixture(kind);
    try {
      await f.login();
      await f.join();
      if (kind === 'grant-expiry') await rpc('short-lease');
      await f.authority.prepare('none', f.epoch());
      await rpc('hold', { stage: kind === 'late-response' ? 'after' : 'before' });
      await f.start();
      await f.choose();
      await rpc('wait-held');
      check(
        await f.js("window.fixtureResult==='pending'"),
        kind + ' withholds native completion during authorization',
      );
      if (['csrf', 'revoke', 'expire', 'replace-lease'].includes(kind)) await rpc(kind);
      if (kind === 'logout') {
        const before = await f.isolated.cookies.get({
          url: f.config.origin,
          name: 'tricord_session',
        });
        const loggedOut = await f.request('/api/auth/logout', {}, f.csrf());
        check(loggedOut.status === 200, 'native logout revokes its session');
        const after = await f.isolated.cookies.get({
          url: f.config.origin,
          name: 'tricord_session',
        });
        check(
          before.length === 1 && after.length === 1 && before[0]!.value === after[0]!.value,
          'revocation-only logout retains the native cookie without replacing authority',
        );
        check(
          (await f.request('/api/auth/me')).status === 401,
          'retained native logout cookie cannot authenticate',
        );
      }
      if (kind === 'session-replacement') {
        await f.request('/api/auth/logout', {}, f.csrf());
        await f.login();
      }
      if (kind === 'navigation') await f.js("location.hash='replacement'");
      if (kind === 'cancel' || kind === 'late-response') f.authority.invalidate();
      if (
        ['session-replacement', 'navigation', 'cancel', 'late-response', 'grant-expiry'].includes(
          kind,
        )
      )
        await f.denied();
      await rpc('release');
      await f.denied();
      await f.drain();
      check(
        await f.js("window.fixtureResult==='denied'&&!window.fixtureStream"),
        kind + ' never yields live tracks after late completion',
      );
      if (['csrf', 'revoke', 'logout', 'expire', 'replace-lease'].includes(kind)) {
        const state = await rpc<{ consumes: number[] }>('state');
        check(
          state.consumes.length === 1 && [401, 403].includes(state.consumes[0]!),
          kind + ' is rejected by fresh server authorization over real HTTP',
        );
      }
      if (kind === 'late-response') {
        const state = await rpc<{ consumes: number[] }>('state');
        check(
          state.consumes[0] === 200,
          'a delayed successful server consume cannot revive cancelled native capture',
        );
      }
    } finally {
      await f.close();
    }
  }
  const watchedLogout = await fixture('logout-watch');
  try {
    await watchedLogout.login();
    await watchedLogout.join();
    await watchedLogout.authority.prepare('none', watchedLogout.epoch());
    check(
      (await watchedLogout.request('/api/auth/logout', {}, watchedLogout.csrf())).status === 200,
      'logout watch starts from a successfully revoked native session',
    );
    await wait(
      () => watchedLogout.authority.inspect() === null,
      'server watch invalidates retained logout cookie',
    );
    check(
      watchedLogout.trace.some((item) => item.path.endsWith('/check') && item.status === 401),
      'native authority watch freshly rejects the retained revoked cookie',
    );
    await watchedLogout.start();
    await watchedLogout.denied();
    check(
      watchedLogout.enumerations() === 0,
      'server-watch invalidation denies a new native request before source enumeration',
    );
  } finally {
    await watchedLogout.close();
  }
  const body = await fixture('body-cleanup');
  try {
    await body.login();
    await body.join();
    await rpc('reject-next');
    body.holdCancellation();
    let ended = false;
    const prepare = body.authority.prepare('none', body.epoch()).catch(() => {
      ended = true;
    });
    await body.cancellationStarted;
    await wait(() => ended, 'logical failure during held body cleanup');
    const count = body.trace.length;
    await assert.rejects(body.authority.prepare('none', body.epoch()), /busy/);
    check(
      body.trace.length === count,
      'actual native response cancellation retains admission through controlled cleanup delay',
    );
    await body.authority.dispose();
    await body.start();
    await body.denied();
    body.releaseCancellation();
    await prepare;
    await body.drain();
    check(
      body.trace.some((item) => item.path.endsWith('/cancel')),
      'owned HTTP cancellation drains after body cleanup',
    );
  } finally {
    await body.close();
  }
  const publishing = await fixture('publication');
  try {
    await publishing.login();
    await publishing.join();
    await rpc('preview-lease');
    await publishing.authority.prepare('none', publishing.epoch());
    await rpc('renew-voice');
    await publishing.start();
    await publishing.choose();
    await publishing.live();
    const grant = await rpc<{ share: { id: string; sourceGeneration: number } }>('publish-screen');
    const status = await publishing.authority.handoff(grant.share.id, grant.share.sourceGeneration);
    check(
      status.remainingMs > 5000,
      'real native/API handoff creates independent publication authority',
    );
    await delay(5500);
    check(
      !!publishing.authority.inspectPublication() &&
        (await publishing.js("window.fixtureStream.getVideoTracks()[0].readyState==='live'")),
      'old preview expiry cannot stop the promoted test-owned capture',
    );
    await rpc('revoke');
    await wait(() => publishing.authority.inspectPublication() === null, 'publication revocation');
    check(
      publishing.trace.some(
        (item) => item.path.endsWith('/publication-check') && item.status === 401,
      ),
      'real main Session.fetch reauthorizes publication against revoked cookies',
    );
  } finally {
    await publishing.close();
  }
  check(BrowserWindow.getAllWindows().length === 0, 'all owned windows and listeners are disposed');
  console.log(
    `PASS: ${checks.length} real Electron session/API/native authority checks; owned video only, physical media unqualified.`,
  );
}
const timeout = setTimeout(() => {
  console.error('Electron authority fixture timed out');
  app.exit(1);
}, 120000);
void run().then(
  () => {
    clearTimeout(timeout);
    app.exit(0);
  },
  (error) => {
    console.error('Last completed authority check:', checks.at(-1));
    console.error(error);
    clearTimeout(timeout);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(1);
  },
);
