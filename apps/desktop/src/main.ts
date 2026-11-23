import { trustedNoticeFrame } from './notification-policy.js';
import { installNotificationMain } from './notification-main.js';
import { createWindowOpenHandler } from './external-links.js';
import { serverUrl } from './server-url.js';
import { MicrophonePermission, microphonePermissions } from './microphone-permission.js';
import { installNativeCapture } from './native-capture.js';
import { createSessionCaptureAuthority } from './capture-authority-http.js';
import { installScreenIpc } from './screen-ipc.js';
import { obsRuntime, obsTarget, nativeCaptureIdentity } from './obs-screen.js';
import { applicationAudioSupported, windowProcessSources } from './application-audio.js';
import {
  app,
  BrowserWindow,
  session,
  dialog,
  ipcMain,
  shell,
  desktopCapturer,
  screen,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { configureUpdates } from './updates.js';
import { installWindowsChrome, windowsChromeOptions } from './window-chrome.js';
import { Menu, Tray, nativeImage } from 'electron';
const smoke = !app.isPackaged && process.argv.includes('--smoke');
const authSmoke = !app.isPackaged && process.argv.includes('--auth-smoke');
const nativeScreenTest = authSmoke && process.argv.includes('--native-screen-smoke');
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
    const microphone = new MicrophonePermission({
      profileDirectory: app.getPath('userData'),
      target,
      ask: async () => {
        if (authSmoke && process.env.TRICORD_VOICE_SMOKE === '1') {
          console.log('TRICORD_SMOKE_MICROPHONE_PERMISSION_PROMPT');
          return true;
        }
        const result = await dialog.showMessageBox({
          type: 'question',
          title: 'Allow microphone access?',
          message: 'Allow Rajcord to use your microphone for voice?',
          detail:
            'Approval is remembered in this app profile for this server. You select a device and join muted. Reset approval from the Rajcord menu. Camera access is disabled. Screen sharing uses its own source picker.',
          buttons: ['Cancel', 'Allow microphone'],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
      onError: (message) => {
        setImmediate(() => dialog.showErrorBox('Microphone permission', message));
      },
    });
    const win = new BrowserWindow({
      title: 'Rajcord',
      icon: path.join(__dirname, '../resources/icon.png'),
      width: 1360,
      height: 880,
      minWidth: 720,
      minHeight: 600,
      show: !smoke && !authSmoke,
      backgroundColor: '#101019',
      ...(process.platform === 'win32' ? windowsChromeOptions() : {}),
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
    const captureAuthority = createSessionCaptureAuthority({
      owner: win,
      session: session.defaultSession,
      origin: target,
      context: () => captureBoundary?.context() ?? null,
      shutdown: app,
      onError: (code) => console.warn('Capture authority unavailable:', code),
    });
    let displayRevision = 0;
    const sourceAudio = applicationAudioSupported();
    const captureBoundary: ReturnType<typeof installNativeCapture> = installNativeCapture({
      owner: win,
      session: session.defaultSession,
      targetOrigin: target,
      permissions: microphonePermissions(win.webContents, target, microphone),
      shutdown: app,
      authority: captureAuthority,
      enabled: true,
      qualification: 'native-provider',
      systemAudio: sourceAudio ? 'consented-windows-loopback' : 'unqualified',
      applicationAudio: sourceAudio,
      enumerate: async (signal) => {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: false,
        });
        if (signal.aborted) throw new Error('Screen enumeration cancelled.');
        const sound = captureAuthority.inspect()?.sound ?? 'none';
        const applicationSources = await windowProcessSources(
          sources.map((source) => source.id),
          signal,
        );
        return sources.flatMap((source) => {
          const previewDataUrl = source.thumbnail.isEmpty()
            ? undefined
            : `data:image/jpeg;base64,${source.thumbnail.toJPEG(65).toString('base64')}`;
          const candidate = {
            id: source.id,
            name: source.name,
            ...applicationSources.get(source.id),
            ...(previewDataUrl ? { previewDataUrl } : {}),
            video: source,
          };
          if (source.id.startsWith('window:') && !candidate.applicationIdentity) return [];
          if (
            source.id.startsWith('screen:') &&
            !screen.getAllDisplays().some((display) => String(display.id) === source.display_id)
          )
            return [];
          if (
            (sound === 'application' && !source.id.startsWith('window:')) ||
            (sound === 'system' && !source.id.startsWith('screen:'))
          )
            return [];
          const target = obsTarget(candidate, screen, sound);
          return [
            {
              ...candidate,
              nativeCaptureIdentity: nativeCaptureIdentity(candidate, target, displayRevision),
            },
          ];
        });
      },
      onError: (code) => console.warn('Display capture boundary unavailable:', code),
    });
    let microphoneResetReady = false;
    const resetMenus: Electron.Menu[] = [];
    const setMicrophoneResetReady = (ready: boolean) => {
      microphoneResetReady = ready;
      for (const menu of resetMenus) {
        const item = menu.getMenuItemById('reset-microphone-permission');
        if (item) item.enabled = ready;
      }
    };
    const createMenu = (template: Electron.MenuItemConstructorOptions[]) => {
      const menu = Menu.buildFromTemplate(template);
      resetMenus.push(menu);
      setMicrophoneResetReady(microphoneResetReady);
      return menu;
    };
    const resetMicrophone = () => {
      if (!microphoneResetReady) return;
      microphone.reset();
      screens.stop();
      if (!win.isDestroyed()) win.webContents.send('microphone:reset');
    };
    const notificationAppId = app.isPackaged ? 'com.rajcord.desktop' : process.execPath;
    const trustedSender = (event: Pick<Electron.IpcMainEvent, 'sender' | 'senderFrame'>) =>
      event.sender === win.webContents &&
      trustedNoticeFrame(
        target,
        event.senderFrame?.url ?? '',
        event.senderFrame === win.webContents.mainFrame,
      );
    installNotificationMain({ owner: win, notificationAppId, authSmoke, trustedSender });
    const obsNativeRuntime = obsRuntime(
      app.isPackaged,
      nativeScreenTest ? process.env.RAJCORD_SCREEN_BENCH_BUNDLE : undefined,
    );
    const screens: ReturnType<typeof installScreenIpc> = installScreenIpc({
      owner: win,
      ipc: ipcMain,
      authority: captureAuthority,
      trusted: trustedSender,
      systemSound: sourceAudio,
      applicationSound: sourceAudio,
      obs: obsNativeRuntime,
      target: (intent) => {
        const selected = captureBoundary.selectedSource(intent);
        if (!selected) throw new Error('The Rajcord screen picker consent ended.');
        const target = obsTarget(selected, screen, intent.sound);
        const identity = nativeCaptureIdentity(selected, target, displayRevision);
        if (identity !== selected.nativeCaptureIdentity)
          throw new Error('The selected native capture source changed. Choose it again.');
        return target;
      },
    });
    const displayChanged = () => {
      displayRevision++;
      if (captureBoundary.hasNativeMonitor()) captureAuthority.invalidate();
    };
    if (obsNativeRuntime.available) {
      const displayMetricsChanged = (_event: unknown, _display: unknown, metrics: string[]) => {
        if (metrics.some((metric) => ['bounds', 'scaleFactor', 'rotation'].includes(metric)))
          displayChanged();
      };
      screen.on('display-added', displayChanged);
      screen.on('display-removed', displayChanged);
      screen.on('display-metrics-changed', displayMetricsChanged);
      win.once('closed', () => {
        screen.removeListener('display-added', displayChanged);
        screen.removeListener('display-removed', displayChanged);
        screen.removeListener('display-metrics-changed', displayMetricsChanged);
      });
    }
    const resetAvailability = (event: Electron.IpcMainEvent, ready: unknown) => {
      if (trustedSender(event) && typeof ready === 'boolean') setMicrophoneResetReady(ready);
    };
    ipcMain.on('microphone:reset-listener', resetAvailability);
    win.webContents.on('did-navigate', () => setMicrophoneResetReady(false));
    win.webContents.on('render-process-gone', () => setMicrophoneResetReady(false));
    win.on('closed', () => {
      ipcMain.removeListener('microphone:reset-listener', resetAvailability);
    });
    win.webContents.setWindowOpenHandler(
      await createWindowOpenHandler({
        target,
        currentUrl: () => win.webContents.getURL(),
        openExternal: (href) => shell.openExternal(href),
        onError: () => {
          console.warn('Could not open web link in the default browser.');
        },
      }),
    );
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
    const updates = configureUpdates(
      async () => {
        await clearTemporarySession();
        await session.defaultSession.cookies.flushStore();
        quitting = true;
      },
      () => {
        quitting = false;
      },
      (progress) => {
        if (!win.isDestroyed()) win.setProgressBar(progress);
      },
    );
    const checkForUpdates = () => {
      void updates.check().catch(() => console.error('Update check failed unexpectedly.'));
    };
    const installUpdate = () => {
      void updates.install().catch(() => console.error('Update installation failed unexpectedly.'));
    };
    Menu.setApplicationMenu(
      createMenu([
        {
          label: 'Rajcord',
          submenu: [
            { label: 'Show Rajcord', click: showWindow },
            { label: 'Stop screen sharing', click: screens.stop },
            {
              id: 'reset-microphone-permission',
              label: 'Reset microphone permission (leaves voice)',
              enabled: microphoneResetReady,
              click: resetMicrophone,
            },
            { label: 'Check for updates…', click: checkForUpdates },
            { label: 'Install downloaded update…', click: installUpdate },
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
    if (process.platform === 'win32') installWindowsChrome(win, trustedSender);
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
          createMenu([
            { label: 'Show Rajcord', click: showWindow },
            { label: 'Stop screen sharing', click: screens.stop },
            {
              id: 'reset-microphone-permission',
              label: 'Reset microphone permission (leaves voice)',
              enabled: microphoneResetReady,
              click: resetMicrophone,
            },
            { label: 'Check for updates…', click: checkForUpdates },
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
    if (authSmoke && process.argv.includes('--native-screen-viewer')) {
      const { showDesktopViewer } = await import('./obs-app-smoke.js');
      showDesktopViewer(win);
    } else if (authSmoke) {
      if (nativeScreenTest) {
        const { nativeScreenSmoke } = await import('./obs-app-smoke.js');
        await nativeScreenSmoke(win, target);
      } else {
        const { runAuthSmoke } = await import('./smoke.js');
        await runAuthSmoke(win, target);
      }
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
    .catch(() => console.warn('Temporary session cleanup failed during shutdown.'))
    .then(() => app.quit())
    .catch(() => console.error('Desktop shutdown failed.'));
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => tray?.destroy());
