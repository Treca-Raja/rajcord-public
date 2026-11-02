import { app, BrowserWindow, session, type WebContents } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopCapturePolicy, type CaptureGrant } from './screen-capture-policy.js';
import { openScreenPicker, screenPickerUrl } from './screen-picker.js';
import { trustedPickerCaller } from './picker-ipc-policy.js';

const profile = process.argv
  .find((arg) => arg.startsWith('--picker-profile='))
  ?.slice('--picker-profile='.length);
const root = path.resolve(__dirname, '../../..');
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== path.join(root, '.local') ||
  !path.basename(profile).startsWith('screen-picker-smoke-')
)
  throw new Error('Owned picker profile required.');
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('Picker fixture timed out.');
  app.exit(1);
}, 45000);
const server = createServer((_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'",
  });
  response.end('<!doctype html><title>Synthetic Rajcord owner</title>Fixture owner');
});
type Source = { id: string; name: string };
const checks: string[] = [];
const policies: DesktopCapturePolicy<Source>[] = [];
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  checks.push(label);
};
async function wait(work: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 120; i++) {
    if (await work()) return;
    await delay(25);
  }
  throw new Error('Picker fixture wait failed: ' + label);
}
async function key(win: BrowserWindow, keyCode: string) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(30);
}
async function navigateFixture(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  try {
    await f.js(script);
  } catch (error) {
    assert.ok(f.win.isDestroyed(), 'Rejected script must have destroyed its fixture window');
    assert.match(String(error), /frame.*disposed|destroyed/i);
  }
}
let target: string;
async function fixture(qualified = false, pauseSelection = false) {
  const owner = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await owner.loadURL(target);
  const grants: (CaptureGrant<Source> | null)[] = [];
  const errors: string[] = [];
  const sources = [
    { id: 'screen:1:0', name: 'Synthetic display · 1080p' },
    { id: 'window:2:0', name: '<img src=x onerror="window.injected=true">' },
  ];
  let picker: BrowserWindow | undefined,
    calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy = new DesktopCapturePolicy({
    owner: owner.webContents,
    targetOrigin: target,
    pickerUrl: screenPickerUrl,
    inspectOwner: () =>
      owner.isDestroyed()
        ? null
        : {
            webContents: owner.webContents,
            mainFrame: owner.webContents.mainFrame,
            url: owner.webContents.getURL(),
            navigation: 1,
            alive: true,
            authorized: true,
            authorizationGeneration: 1,
          },
    enumerate: async () => {
      if (++calls === 2 && pauseSelection) await gate;
      return sources.map((source) => ({ ...source }));
    },
    openPicker: async (_snapshot, signal) => {
      const port = await openScreenPicker({ owner, policy, signal, visible: false });
      picker = BrowserWindow.fromWebContents(port.inspect()!.webContents as WebContents)!;
      return port;
    },
    systemAudio: qualified ? 'qualified-windows-loopback' : 'unqualified',
    onError: (code) => errors.push(code),
    timeoutMs: 15000,
  });
  policies.push(policy);
  assert.equal(
    policy.begin(
      {
        frame: owner.webContents.mainFrame,
        securityOrigin: target,
        videoRequested: true,
        audioRequested: true,
        userGesture: true,
      },
      (grant) => grants.push(grant),
    ).ok,
    true,
  );
  await wait(
    async () =>
      !!picker &&
      !picker.isDestroyed() &&
      (await picker.webContents.executeJavaScript(
        "document.querySelectorAll('.source').length===2",
      )),
    'picker ready',
  );
  const win = picker!;
  const js = <T = unknown>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true);
  const close = () => {
    release();
    policy.dispose();
    if (!owner.isDestroyed()) owner.destroy();
  };
  return { owner, win, js, policy, grants, sources, errors, release, close };
}
async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  target = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const f = await fixture();
  try {
    check(
      await f.js(
        "typeof require==='undefined' && typeof process==='undefined' && typeof window.tricordDesktop==='undefined' && Object.isFrozen(window.rajcordCapturePicker)",
      ),
      'picker-only frozen bridge without Node or remote app bridge',
    );
    check(
      await f.js(
        "Object.keys(window.rajcordCapturePicker).sort().join(',')==='cancel,getSources,select'",
      ),
      'only three narrow bridge methods',
    );
    check(
      await f.js(
        "document.getElementById('confirm').disabled && !document.querySelector('input:checked') && !document.querySelector('[aria-pressed=true]')",
      ),
      'no default source or sound consent',
    );
    check(
      await f.js(
        "!document.querySelector('img') && document.querySelectorAll('.source-label')[1].textContent.startsWith('<img') && !window.injected",
      ),
      'source labels rendered as text',
    );
    check(
      await f.js(
        "window.rajcordCapturePicker.getSources().then(r=>r.ok && r.data.sources.length===2 && !JSON.stringify(r).includes('screen:1:0'))",
      ),
      'authorized DTO without raw source ID',
    );
    check(
      await f.js(
        "(()=>{const s=document.createElement('script');s.textContent='window.fixtureInline=true';document.body.append(s);return !window.fixtureInline})()",
      ),
      'CSP blocks injected inline script',
    );
    check(
      await f.js(
        `fetch(${JSON.stringify(target + '/blocked-picker-request')}).then(()=>false,()=>true)`,
      ),
      'CSP blocks network requests',
    );
    await f.js("document.querySelector('.source').focus()");
    await key(f.win, 'Space');
    check(
      await f.js(
        "document.querySelector('.source').getAttribute('aria-pressed')==='true' && document.getElementById('confirm').disabled && document.getElementById('system-sound').disabled",
      ),
      'keyboard source choice and unqualified sound gating',
    );
    await f.js("document.querySelector('input[value=none]').focus()");
    await key(f.win, 'Space');
    check(
      await f.js(
        "document.querySelector('input[value=none]').checked && !document.getElementById('confirm').disabled",
      ),
      'explicit keyboard video-only consent',
    );
    const artifacts = path.join(root, 'artifacts');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(artifacts, 'screen-picker.png'),
      (await f.win.webContents.capturePage()).toPNG(),
    );
    await f.js("document.getElementById('confirm').focus()");
    await key(f.win, 'Enter');
    await wait(() => f.grants.length === 1, 'native fixture grant');
    check(
      f.grants[0]?.video.id === f.sources[0]!.id && !f.grants[0]?.audio && f.win.isDestroyed(),
      'one video-only native fixture result and closed picker',
    );
    check(f.errors.length === 0, 'no unexpected picker errors');
  } finally {
    f.close();
  }

  const sound = await fixture(true);
  try {
    await sound.js(
      "document.querySelector('.source').click();document.getElementById('system-sound').click()",
    );
    check(
      await sound.js(
        "!document.getElementById('system-sound').disabled && document.getElementById('sound-help').textContent.includes('other applications')",
      ),
      'qualified synthetic system sound warning and choice',
    );
    await sound.js("document.querySelectorAll('.source')[1].click()");
    check(
      await sound.js(
        "!document.querySelector('input:checked') && document.getElementById('system-sound').disabled && document.getElementById('confirm').disabled",
      ),
      'source switches reset sound consent and window loopback stays unavailable',
    );
    await sound.js(
      "document.querySelector('.source').click();document.getElementById('system-sound').click()",
    );
    await sound.js("document.getElementById('confirm').click()");
    await wait(() => sound.grants.length === 1, 'sound fixture grant');
    check(sound.grants[0]?.audio === 'loopback', 'explicit loopback fixture result without media');
  } finally {
    sound.close();
  }

  const duplicate = await fixture(false, true);
  try {
    const result = await duplicate.js<{ ok: boolean; code?: string }>(
      "(async()=>{const r=await window.rajcordCapturePicker.getSources();const choice={requestId:r.data.requestId,handle:r.data.sources[0].handle,sound:'none'};window.fixtureSelection=window.rajcordCapturePicker.select(choice);return window.rajcordCapturePicker.select(choice)})()",
    );
    check(
      !result.ok && result.code === 'busy',
      'duplicate real IPC selection cannot consume a pending handle twice',
    );
    duplicate.release();
    await wait(() => duplicate.grants.length === 1, 'duplicate selection completion');
    check(
      duplicate.grants[0] !== null && duplicate.grants.length === 1,
      'one native fixture result after duplicate selection',
    );
  } finally {
    duplicate.close();
  }

  const cancelled = await fixture(false, true);
  try {
    await cancelled.js(
      "document.querySelector('.source').click();document.querySelector('input[value=none]').click();document.getElementById('confirm').click()",
    );
    await wait(
      async () =>
        await cancelled.js<boolean>(
          "document.getElementById('status').textContent.includes('Checking')",
        ),
      'pending selection',
    );
    check(
      await cancelled.js("!document.getElementById('cancel').disabled"),
      'Cancel remains available during validation',
    );
    await key(cancelled.win, 'Escape');
    await wait(
      () => cancelled.grants.length === 1 && cancelled.win.isDestroyed(),
      'Escape cancellation',
    );
    cancelled.release();
    await delay(50);
    check(
      cancelled.grants.length === 1 && cancelled.grants[0] === null,
      'late selection completion cannot revive a cancelled picker',
    );
  } finally {
    cancelled.close();
  }

  const foreign = await fixture();
  const other = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'picker-preload.js'),
    },
  });
  try {
    await other.loadURL(screenPickerUrl);
    check(
      await other.webContents.executeJavaScript(
        'window.rajcordCapturePicker.getSources().then(r=>!r.ok)',
      ),
      'foreign WebContents cannot invoke picker-scoped handlers',
    );
    check(foreign.grants.length === 0, 'foreign requests cannot cancel legitimate picker');
    await other.webContents.executeJavaScript(
      "(()=>{const frame=document.createElement('iframe');frame.srcdoc='<p>blocked fixture</p>';document.body.append(frame)})()",
    );
    await delay(50);
    const frame = other.webContents.mainFrame.frames[0];
    assert.ok(frame, 'Synthetic subframe exists');
    check(
      await frame.executeJavaScript("typeof window.rajcordCapturePicker==='undefined'"),
      'subframe receives no picker preload bridge',
    );
    const document = {
      webContents: other.webContents,
      mainFrame: other.webContents.mainFrame,
      url: screenPickerUrl,
      navigation: 1,
      alive: true,
    };
    check(
      !trustedPickerCaller(document, document, other.webContents, frame),
      'native subframe identity fails IPC guard',
    );
    await foreign.js("window.open('https://example.invalid')");
    check(BrowserWindow.getAllWindows().length === 3, 'popup denied');
    await navigateFixture(
      foreign,
      "(()=>{const frame=document.createElement('iframe');frame.srcdoc='<p>blocked fixture</p>';document.body.append(frame)})()",
    );
    await wait(() => foreign.win.isDestroyed(), 'subframe attempt invalidation');
    check(
      foreign.grants.length === 1 && foreign.grants[0] === null,
      'subframe navigation denies native fixture exactly once',
    );
  } finally {
    if (!other.isDestroyed()) other.destroy();
    foreign.close();
  }

  const destroyed = await fixture();
  destroyed.win.destroy();
  await wait(() => destroyed.grants.length === 1, 'window destruction');
  check(destroyed.grants[0] === null, 'picker destruction cancels request');
  destroyed.close();
  const navigating = await fixture();
  await navigateFixture(navigating, "location.hash='changed'");
  await wait(() => navigating.win.isDestroyed(), 'same-document navigation invalidation');
  check(
    navigating.grants.length === 1 && navigating.grants[0] === null,
    'same-document navigation cancels request',
  );
  navigating.close();
  const ownerNavigates = await fixture();
  await ownerNavigates.owner.loadURL(target + '/changed');
  await wait(
    () => ownerNavigates.grants.length === 1 && ownerNavigates.win.isDestroyed(),
    'owner navigation',
  );
  check(ownerNavigates.grants[0] === null, 'owner navigation invalidates picker');
  ownerNavigates.close();
  console.log(
    `PASS: ${checks.length} isolated Electron picker checks with synthetic sources; no capture or device enumeration.`,
  );
}
void run().then(
  () => {
    clearTimeout(timeout);
    server.close();
    app.exit(0);
  },
  (error) => {
    for (const policy of policies) policy.dispose();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    console.error('Last completed picker check:', checks.at(-1));
    console.error(error);
    clearTimeout(timeout);
    server.close();
    app.exit(1);
  },
);
