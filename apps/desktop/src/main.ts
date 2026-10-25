import { serverUrl } from './server-url.js';
import { trustedAudioRequest, trustedAudioCheck } from './media-permissions.js';
import { app, BrowserWindow, session, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { runAuthSmoke } from './smoke.js';
const smoke = process.argv.includes('--smoke');
const authSmoke = process.argv.includes('--auth-smoke');
const local = authSmoke ? process.env.TRICORD_TEST_PROFILE : path.resolve(__dirname, '../.local');
if (!local) throw new Error('Test profile required.');
fs.mkdirSync(local, { recursive: true });
app.setPath('userData', local);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
if (authSmoke && process.env.TRICORD_VOICE_SMOKE === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}
const target = serverUrl(process.env, authSmoke);
let quitting = false;
async function clearTemporarySession() {
  const cookies = await session.defaultSession.cookies.get({
    name: 'tricord_session',
    url: target,
  });
  if (!cookies.some((cookie) => cookie.session)) return;
  try {
    const response = await session.defaultSession.fetch(target + '/api/auth/me', {
      credentials: 'include',
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const state = await response.json();
      if (!state.remember)
        await session.defaultSession.fetch(target + '/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { Origin: target, 'X-CSRF-Token': state.csrfToken },
          signal: AbortSignal.timeout(2500),
        });
    }
  } catch {
    console.warn('Temporary local session cleared; offline server revocation will rely on expiry.');
  } finally {
    for (const cookie of cookies.filter((cookie) => cookie.session))
      await session.defaultSession.cookies.remove(
        'http' +
          (cookie.secure ? 's' : '') +
          '://' +
          (cookie.domain ?? new URL(target).hostname).replace(/^\./, '') +
          cookie.path,
        cookie.name,
      );
    await session.defaultSession.cookies.flushStore();
  }
}
app
  .whenReady()
  .then(async () => {
    await clearTemporarySession();
    let microphoneAllowed = authSmoke && process.env.TRICORD_VOICE_SMOKE === '1';
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (
          !contents ||
          !trustedAudioRequest(
            target,
            details.requestingUrl,
            details.isMainFrame,
            permission,
            'mediaTypes' in details ? details.mediaTypes : undefined,
          )
        ) {
          callback(false);
          return;
        }
        if (microphoneAllowed || (authSmoke && process.env.TRICORD_VOICE_SMOKE === '1')) {
          microphoneAllowed = true;
          callback(true);
          return;
        }
        void dialog
          .showMessageBox({
            type: 'question',
            title: 'Allow microphone access?',
            message: 'Allow Tricord to use your microphone for voice?',
            detail:
              'You select a device and join muted. Camera and screen capture remain disabled.',
            buttons: ['Cancel', 'Allow microphone'],
            defaultId: 0,
            cancelId: 0,
          })
          .then((result) => {
            microphoneAllowed = result.response === 1;
            callback(microphoneAllowed);
          })
          .catch(() => callback(false));
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        !!contents &&
        microphoneAllowed &&
        trustedAudioCheck(target, origin, details.isMainFrame, permission, details.mediaType),
    );
    const win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 720,
      minHeight: 600,
      show: !smoke && !authSmoke,
      backgroundColor: '#16191f',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    await win.loadURL(target);
    if (authSmoke) {
      await runAuthSmoke(win, target);
      app.quit();
    } else if (smoke) {
      const result = await win.webContents.executeJavaScript(
        "new Promise((resolve,reject)=>{const end=Date.now()+15000;const timer=setInterval(()=>{if(document.querySelector('input[name=username]')){clearInterval(timer);resolve({signIn:true,isolated:typeof require==='undefined'&&typeof process==='undefined',desktop:window.tricordDesktop?.platform})}else if(Date.now()>end){clearInterval(timer);reject(new Error('Sign-in screen timed out'))}},100)})",
      );
      const artifacts = path.resolve(__dirname, '../../../artifacts');
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'desktop.json'), JSON.stringify(result, null, 2));
      if (!result.isolated) throw new Error('Renderer isolation failed.');
      app.quit();
    }
  })
  .catch((error: Error) => {
    console.error('Desktop startup or verification failed: ' + error.message);
    app.exit(1);
  });
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void clearTemporarySession()
    .then(() => session.defaultSession.cookies.flushStore())
    .finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
