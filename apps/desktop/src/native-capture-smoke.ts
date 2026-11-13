import { app, BrowserWindow, session, type WebContents } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installNativeCapture, type TrustedCaptureIntent } from './native-capture.js';
import { openScreenPicker } from './screen-picker.js';
import { ServerCaptureAuthority } from './capture-authority.js';

const profile = process.argv
  .find((arg) => arg.startsWith('--picker-profile='))
  ?.slice('--picker-profile='.length);
const root = path.resolve(__dirname, '../../..');
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== path.join(root, '.local') ||
  !path.basename(profile).startsWith('screen-picker-smoke-')
)
  throw new Error('Owned capture fixture profile required.');
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('Native capture fixture timed out.');
  app.exit(1);
}, 45000);
const server = createServer((request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'",
  });
  response.end(
    request.url === '/source'
      ? '<!doctype html><title>Synthetic source</title><body style="background:#263329;color:white">TEST-OWNED SYNTHETIC SOURCE</body>'
      : request.url === '/child'
        ? '<!doctype html><title>Synthetic child</title>'
        : '<!doctype html><title>Synthetic requester</title><iframe src="/child"></iframe>',
  );
});
const checks: string[] = [];
const check = (condition: unknown, name: string) => {
  assert.ok(condition, name);
  checks.push(name);
};
const boundaries: ReturnType<typeof installNativeCapture>[] = [];
const capture =
  "window.fixtureResult='pending';navigator.mediaDevices.getDisplayMedia({video:true,audio:false}).then(stream=>{window.fixtureStream=stream;window.fixtureResult='live'},error=>{window.fixtureResult='denied';window.fixtureError=error.name});void 0";
async function wait(work: () => Promise<boolean> | boolean, name: string, attempts = 160) {
  for (let i = 0; i < attempts; i++) {
    if (await work()) return;
    await delay(25);
  }
  throw new Error('Native capture fixture wait failed: ' + name);
}
let target: string;
async function fixture(
  enabled?: boolean,
  hasAuthority = true,
  pauseEnumeration = false,
  logicalAuthority = false,
) {
  const isolated = session.fromPartition('native-capture-fixture-' + randomUUID());
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
  await source.loadURL(target + '/source');
  await owner.loadURL(target + '/requester');
  let intent: TrustedCaptureIntent | null = null,
    enumerationCalls = 0,
    picker: BrowserWindow | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listeners = new Set<() => void>(),
    errors: string[] = [];
  const authority = {
    inspect: () => intent,
    verify: async (value: TrustedCaptureIntent) =>
      intent?.intent === value.intent && intent.authorization === value.authorization,
    onInvalidated: (callback: () => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  let consumePaused = logicalAuthority,
    cancelCalls = 0;
  let finishConsume: ((value: unknown) => void) | undefined;
  const grantId = randomUUID();
  const serverAuthority = logicalAuthority
    ? new ServerCaptureAuthority({
        context: () => boundary.context(),
        transport: async (operation) => {
          if (operation === 'consume' && consumePaused) {
            consumePaused = false;
            return new Promise((resolve) => {
              finishConsume = resolve;
            });
          }
          if (operation === 'cancel') {
            cancelCalls++;
            return { cancelled: true };
          }
          return { id: grantId, remainingMs: 45000 };
        },
        onError: (code) => errors.push(code),
      })
    : undefined;
  const boundary: ReturnType<typeof installNativeCapture> = installNativeCapture({
    owner,
    session: isolated,
    targetOrigin: target,
    enabled,
    qualification: 'synthetic-webcontents',
    authority: hasAuthority ? (serverAuthority ?? authority) : undefined,
    permissions: { check: () => false, request: (_wc, _permission, cb) => cb(false) },
    enumerate: async () => {
      enumerationCalls++;
      if (pauseEnumeration) await gate;
      return [
        {
          id: 'window:100:0',
          name: 'Test-owned synthetic source',
          video: source.webContents.mainFrame,
        },
      ];
    },
    openPicker: async (_snapshot, signal, policy) => {
      const port = await openScreenPicker({ owner, policy, signal, visible: false });
      picker = BrowserWindow.fromWebContents(port.inspect()!.webContents as WebContents)!;
      return port;
    },
    onError: (code) => errors.push(code),
    shutdown: app,
  });
  boundaries.push(boundary);
  const context = boundary.context()!;
  const issue = async () => {
    if (serverAuthority) {
      await serverAuthority.prepare('none', randomUUID());
      return;
    }
    intent = {
      intent: {},
      authorization: {},
      generation: 1,
      expires: Date.now() + 10000,
      frame: owner.webContents.mainFrame,
      url: owner.webContents.getURL(),
      navigation: boundary.context()!.navigation,
      sound: 'none',
    };
  };
  const js = <T = unknown>(script: string): Promise<T> =>
    owner.webContents.executeJavaScript(script, true);
  const start = () => js(capture);
  const result = (wanted: string, attempts = 160) =>
    wait(
      async () => await js<boolean>(`window.fixtureResult===${JSON.stringify(wanted)}`),
      wanted,
      attempts,
    );
  const choose = async () => {
    await wait(
      async () =>
        !!picker &&
        !picker.isDestroyed() &&
        (await picker.webContents.executeJavaScript(
          "document.querySelectorAll('.source').length===1",
        )),
      'local picker',
    );
    await picker!.webContents.executeJavaScript(
      "document.querySelector('.source').click();document.querySelector('input[value=none]').click();document.getElementById('confirm').click()",
      true,
    );
  };
  return {
    owner,
    source,
    isolated,
    boundary,
    errors,
    context,
    issue,
    consumePending: () => !!finishConsume,
    completeConsume: () => finishConsume?.({ id: grantId, remainingMs: 10000 }),
    cancelCalls: () => cancelCalls,
    inspectAuthority: () => serverAuthority?.inspect(),
    start,
    result,
    js,
    choose,
    calls: () => enumerationCalls,
    revoke: () => {
      intent = null;
      for (const listener of listeners) listener();
    },
    release,
    close: async () => {
      release();
      finishConsume?.({ id: grantId, remainingMs: 10000 });
      await serverAuthority?.dispose();
      if (!owner.isDestroyed())
        await js('window.fixtureStream?.getTracks().forEach(track=>track.stop())');
      boundary.dispose();
      if (!owner.isDestroyed()) owner.destroy();
      if (!source.isDestroyed()) source.destroy();
      assert.equal(listeners.size, 0);
    },
  };
}
async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  target = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  for (const [enabled, authority] of [
    [undefined, true],
    [true, false],
  ] as const) {
    const f = await fixture(enabled, authority);
    try {
      await f.issue();
      await f.start();
      await f.result('denied');
      check(
        f.calls() === 0,
        enabled
          ? 'missing authority denies before enumeration'
          : 'default-disabled boundary denies before enumeration',
      );
    } finally {
      await f.close();
    }
  }
  const f = await fixture(true);
  try {
    await f.issue();
    const child = f.owner.webContents.mainFrame.frames[0]!;
    await child.executeJavaScript(capture, true);
    await wait(
      async () => (await child.executeJavaScript("window.fixtureResult==='denied'")) === true,
      'subframe rejection',
    );
    check(f.calls() === 0, 'subframe cannot use the armed main-frame intent');
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        session: f.isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await foreign.loadURL(target + '/requester');
      await foreign.webContents.executeJavaScript(capture, true);
      await wait(
        async () => await foreign.webContents.executeJavaScript("window.fixtureResult==='denied'"),
        'foreign window rejection',
      );
      check(f.calls() === 0, 'same-session foreign WebContents cannot use intent');
    } finally {
      foreign.destroy();
    }
    await f.start();
    await f.choose();
    await f.result('live');
    check(
      await f.js(
        "window.fixtureStream.getVideoTracks().length===1 && window.fixtureStream.getVideoTracks()[0].readyState==='live' && window.fixtureStream.getAudioTracks().length===0",
      ),
      'native handler and picker return one live synthetic video track and no audio',
    );
    check(f.calls() === 2, 'selected synthetic source rechecked before native completion');
    await f.js('window.fixtureStream.getTracks().forEach(track=>track.stop())');
    check(
      await f.js("window.fixtureStream.getTracks().every(track=>track.readyState==='ended')"),
      'owned fixture capture tracks stop',
    );
    await f.start();
    await f.result('denied');
    check(f.calls() === 2, 'consumed intent cannot reopen capture');
    f.boundary.dispose();
    await f.start();
    await f.result('denied');
    check(f.calls() === 2, 'disposed boundary keeps display capture denied');
    check(f.errors.length === 0, 'no unexpected native boundary errors');
  } finally {
    await f.close();
  }
  const pending = await fixture(true, true, true);
  try {
    await pending.issue();
    await pending.start();
    await wait(() => pending.calls() === 1, 'pending synthetic source enumeration');
    pending.revoke();
    await pending.result('denied');
    pending.release();
    await delay(50);
    check(
      BrowserWindow.getAllWindows().length === 2,
      'revocation consumes native callback before late source completion without a picker',
    );
    await pending.issue();
    await pending.start();
    await pending.choose();
    await pending.result('live');
    check(pending.calls() === 3, 'a fresh trusted intent recovers after late completion');
  } finally {
    await pending.close();
  }
  const timed = await fixture(true, true, false, true);
  try {
    await timed.issue();
    await timed.start();
    await timed.choose();
    await wait(timed.consumePending, 'held synthetic consume');
    check(
      await timed.js("window.fixtureResult==='pending'"),
      'native completion waits for fresh consume',
    );
    // This case intentionally exceeds the five-second logical request deadline.
    await timed.result('denied', 240);
    check(
      timed.inspectAuthority() === null,
      'logical consume timeout denies native capture and invalidates intent',
    );
    await assert.rejects(timed.issue(), /busy/);
    check(
      timed.calls() === 2,
      'ignored native abort retains admission before source re-enumeration',
    );
    timed.completeConsume();
    await wait(() => timed.cancelCalls() === 1, 'old request cancellation after late consume');
    check(
      await timed.js("window.fixtureResult==='denied'&&!window.fixtureStream"),
      'late consume cannot return a live capture',
    );
    await timed.issue();
    await timed.start();
    await timed.choose();
    await timed.result('live');
    check(
      await timed.js(
        'window.fixtureStream.getVideoTracks().length===1&&window.fixtureStream.getAudioTracks().length===0',
      ),
      'a fresh intent and gesture recover after owned native cleanup',
    );
  } finally {
    await timed.close();
  }
  console.log(
    `PASS: ${checks.length} native Electron display-boundary checks; only test-owned WebContents video, no desktop/audio enumeration or performance benchmark.`,
  );
}
void run().then(
  () => {
    clearTimeout(timeout);
    server.close();
    app.exit(0);
  },
  (error) => {
    for (const boundary of boundaries) boundary.dispose();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    console.error('Last completed native check:', checks.at(-1));
    console.error(error);
    clearTimeout(timeout);
    server.close();
    app.exit(1);
  },
);
