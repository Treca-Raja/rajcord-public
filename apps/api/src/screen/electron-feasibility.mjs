// Standalone test process. Never imported by the Rajcord desktop application.
import { app, BrowserWindow, session } from 'electron';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin = process.env.TRICORD_SCREEN_ORIGIN;
const trustedOrigin = (value) => value === origin || value === origin + '/';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? ''))
  throw new Error('Loopback fixture origin required');
if (!process.env.TRICORD_SCREEN_PROFILE || !process.env.TRICORD_SCREEN_OUTPUT)
  throw new Error('Disposable fixture paths required');
app.setPath('userData', process.env.TRICORD_SCREEN_PROFILE);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const settings = JSON.parse(process.env.TRICORD_SCREEN_OPTIONS);
const windows = [];
const report = {
  runtime: 'electron-offscreen',
  versions: process.versions,
  scenarios: [],
  captureRequests: [],
  failure: null,
};
let allowedPublisher;
let source;
app
  .whenReady()
  .then(async () => {
    const { runScenario } = await import(process.env.TRICORD_SCREEN_RUNNER);
    const fixtureSession = session.fromPartition('screen-feasibility');
    fixtureSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(
        contents === allowedPublisher?.webContents &&
          permission === 'display-capture' &&
          details.requestingUrl === origin + '/publisher' &&
          details.isMainFrame === true,
      ),
    );
    fixtureSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        contents === allowedPublisher?.webContents &&
        permission === 'display-capture' &&
        trustedOrigin(requestingOrigin) &&
        details.isMainFrame === true,
    );
    fixtureSession.setDisplayMediaRequestHandler((request, callback) => {
      report.captureRequests.push({
        trustedFrame: request.frame === allowedPublisher?.webContents.mainFrame,
        trustedOrigin: trustedOrigin(request.securityOrigin),
        userGesture: request.userGesture,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
      });
      if (
        !source ||
        !allowedPublisher ||
        request.frame !== allowedPublisher.webContents.mainFrame ||
        !trustedOrigin(request.securityOrigin) ||
        !request.userGesture ||
        !request.videoRequested ||
        !request.audioRequested
      ) {
        callback(null);
        return;
      }
      // Captures only this test's WebContents. Never enumerate/capture desktop windows or system audio.
      callback({
        video: source.webContents.mainFrame,
        audio: source.webContents.mainFrame,
        enableLocalEcho: false,
      });
    });
    async function page(role) {
      const win = new BrowserWindow({
        show: false,
        width: 1920,
        height: 1080,
        useContentSize: true,
        webPreferences: {
          session: fixtureSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          offscreen: true,
        },
      });
      windows.push(win);
      win.webContents.setFrameRate(60);
      win.webContents.on('paint', () => {});
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => {
        if (url !== origin + '/' + role) event.preventDefault();
      });
      win.webContents.setAudioMuted(true);
      await win.loadURL(origin + '/' + role);
      assert.equal(
        await win.webContents.executeJavaScript(
          "typeof require==='undefined'&&typeof process==='undefined'&&!!window.screenFixture",
        ),
        true,
      );
      return {
        win,
        js: (expression) =>
          win.webContents.executeJavaScript(
            '(async()=>{try{return await (' +
              expression +
              ')}catch(error){throw new Error(String(error.name)+": "+String(error.message))}})()',
            true,
          ),
      };
    }
    const publisher = await page('publisher');
    const receiver = await page('receiver');
    report.scenarios.push(
      await runScenario(publisher, receiver, {
        mode: 'canvas',
        codec: settings.codec,
        content: settings.content,
        phaseMs: settings.phaseMs,
      }),
    );
    // A fresh page prevents stopped fixture resources leaking into the capture run.
    const displayPublisher = await page('publisher');
    const displayReceiver = await page('receiver');
    const displaySource = await page('source');
    allowedPublisher = displayPublisher.win;
    source = displaySource.win;
    report.scenarios.push(
      await runScenario(displayPublisher, displayReceiver, {
        mode: 'display',
        codec: settings.codec,
        content: settings.content,
        phaseMs: settings.phaseMs,
        source: displaySource,
      }),
    );
    report.processMetrics = app
      .getAppMetrics()
      .map((metric) => ({ type: metric.type, cpu: metric.cpu, memory: metric.memory }));
  })
  .catch((error) => {
    report.failure = typeof error?.message === 'string' ? error.message : String(error);
    if (error.screenEvidence) report.scenarios.push({ failedScenario: error.screenEvidence });
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    await writeFile(process.env.TRICORD_SCREEN_OUTPUT, JSON.stringify(report, null, 2));
    app.exit(process.exitCode || 0);
  });
app.on('window-all-closed', () => {});
