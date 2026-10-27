import { validNotice, trustedNoticeFrame } from './notification-policy.js';
import { serverUrl } from './server-url.js';
import { trustedAudioRequest, trustedAudioCheck } from './media-permissions.js';
import { app, BrowserWindow, session, dialog, ipcMain, Notification, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { configureUpdates } from './updates.js';
import { Menu, Tray, nativeImage } from 'electron';
const smoke = !app.isPackaged && process.argv.includes('--smoke');
const authSmoke = !app.isPackaged && process.argv.includes('--auth-smoke');
const local = authSmoke ? process.env.TRICORD_TEST_PROFILE : path.resolve(__dirname, '../.local');
if (!local) throw new Error('Test profile required.');
app.setName('Rajcord');
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Rajcord'));
else {
  fs.mkdirSync(local, { recursive: true });
  app.setPath('userData', local);
}
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
const target = serverUrl(process.env, authSmoke, app.isPackaged);
let quitting = false;
let tray: Tray | undefined;
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
            message: 'Allow Rajcord to use your microphone for voice?',
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
      title: 'Rajcord',
      icon: path.join(__dirname, '../resources/icon.png'),
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
        additionalArguments: ['--rajcord-version=' + app.getVersion()],
      },
    });
    const notificationAppId = app.isPackaged ? 'com.rajcord.desktop' : process.execPath;
    app.setAppUserModelId(notificationAppId);
    const trustedSender = (event: Electron.IpcMainInvokeEvent) =>
      event.sender === win.webContents &&
      trustedNoticeFrame(
        target,
        event.senderFrame?.url ?? '',
        event.senderFrame === win.webContents.mainFrame,
      );
    ipcMain.handle('notifications:enable', (event) => {
      if (!trustedSender(event) || !Notification.isSupported()) return false;
      if (process.platform !== 'win32' || app.isPackaged) return true;
      // Windows associates development toasts with a Start Menu shortcut, as documented by Electron.
      const shortcut = path.join(
        app.getPath('appData'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Rajcord development.lnk',
      );
      try {
        if (fs.existsSync(shortcut)) {
          const existing = shell.readShortcutLink(shortcut);
          if (existing.target !== process.execPath || existing.appUserModelId !== notificationAppId)
            return false;
        }
        return shell.writeShortcutLink(shortcut, fs.existsSync(shortcut) ? 'update' : 'create', {
          target: process.execPath,
          args: '"' + path.join(__dirname, 'main.js') + '"',
          cwd: path.resolve(__dirname, '../../..'),
          appUserModelId: notificationAppId,
          description: 'Rajcord development app notification registration',
        });
      } catch {
        return false;
      }
    });
    const notices = new Set<Notification>();
    let lastAlert = 0;
    ipcMain.handle('notifications:show', async (event, value: unknown) => {
      if (
        event.sender !== win.webContents ||
        !trustedNoticeFrame(
          target,
          event.senderFrame?.url ?? '',
          event.senderFrame === win.webContents.mainFrame,
        ) ||
        !validNotice(value) ||
        !Notification.isSupported()
      )
        return false;
      if (Date.now() - lastAlert < 3000) return true;
      lastAlert = Date.now();
      try {
        const notification = new Notification({
          title: 'Rajcord',
          body: value.mention
            ? 'You were mentioned. Open Rajcord to read it.'
            : 'New private message. Open Rajcord to read it.',
          silent: true,
        });
        notices.add(notification);
        notification.on('close', () => notices.delete(notification));
        notification.on('failed', () => notices.delete(notification));
        notification.on('click', () => {
          if (win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          win.webContents.send('notifications:open', value.conversationId);
          notification.close();
        });
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            notification.close();
            resolve(false);
          }, 4000);
          notification.once('show', () => {
            clearTimeout(timer);
            resolve(true);
          });
          notification.once('failed', () => {
            clearTimeout(timer);
            resolve(false);
          });
          notification.show();
        });
      } catch {
        return false;
      }
    });
    win.on('closed', () => {
      ipcMain.removeHandler('notifications:show');
      ipcMain.removeHandler('notifications:enable');
      for (const notice of notices) notice.close();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== target) event.preventDefault();
    });
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      win.setTitle('Rajcord');
    });
    const showWindow = () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    };
    const updates = configureUpdates(async () => {
      await clearTemporarySession();
      await session.defaultSession.cookies.flushStore();
      quitting = true;
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Rajcord',
          submenu: [
            { label: 'Show Rajcord', click: showWindow },
            { label: 'Check for updates…', click: updates.check },
            { label: 'Install downloaded update…', click: updates.install },
            { type: 'separator' },
            { label: 'Quit Rajcord', accelerator: 'Control+Q', click: () => app.quit() },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
        },
      ]),
    );
    if (app.isPackaged) {
      win.on('query-session-end', () => {
        quitting = true;
      });
      try {
        tray = new Tray(
          nativeImage
            .createFromPath(path.join(__dirname, '../resources/icon.png'))
            .resize({ width: 32, height: 32 }),
        );
        tray.setToolTip('Rajcord — close keeps voice running; Quit disconnects');
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: 'Show Rajcord', click: showWindow },
            { label: 'Check for updates…', click: updates.check },
            { label: 'Quit Rajcord', click: () => app.quit() },
          ]),
        );
        tray.on('double-click', showWindow);
      } catch {
        tray = undefined;
      }
      win.on('close', (event) => {
        if (!quitting && tray) {
          event.preventDefault();
          win.hide();
        }
      });
    }
    try {
      await win.loadURL(target);
    } catch (error) {
      if (!app.isPackaged) throw error;
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Rajcord unavailable',
        message:
          'Could not connect to https://rajcord.com. Check your connection and restart Rajcord.',
      });
      app.quit();
    }
    if (authSmoke) {
      const { runAuthSmoke } = await import('./smoke.js');
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
app.on('will-quit', () => tray?.destroy());
