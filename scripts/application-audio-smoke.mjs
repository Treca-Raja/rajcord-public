import { app, BrowserWindow, session, desktopCapturer } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  applicationAudioSources,
  applicationAudioSupported,
} from '../apps/desktop/dist/application-audio.js';
const fixturePath = fileURLToPath(import.meta.url);
const mode = process.argv.find((x) => x.startsWith('--mode='))?.slice(7) || 'capture';
const profile = process.argv.find((x) => x.startsWith('--audio-profile='))?.slice(16);
const root = fileURLToPath(new URL('../', import.meta.url));
if (
  !profile ||
  path.dirname(path.resolve(profile)) !== path.join(root, '.local') ||
  !path.basename(profile).startsWith('application-audio-smoke-')
)
  throw new Error('Owned audio profile required.');
app.setPath('userData', path.join(profile, mode));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
const children = [];
let stage = 'starting';
const cleanup = () => {
  for (const child of children) child.kill();
};
const deadline = setTimeout(() => {
  cleanup();
  console.error('Application audio fixture timed out.');
  app.exit(1);
}, 35000);
app.on('will-quit', cleanup);
app
  .whenReady()
  .then(async () => {
    stage = 'runtime qualification';
    assert.ok(applicationAudioSupported(), 'Runtime must be qualified for application loopback.');
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<title>Rajcord owned audio fixture</title>Owned synthetic source. No private desktop or microphone.',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({
      show: mode !== 'capture',
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await win.loadURL('http://127.0.0.1:' + server.address().port);
    stage = 'synthetic tone startup';
    if (mode !== 'capture') {
      await win.webContents.executeJavaScript(
        `const ac=new AudioContext();const osc=ac.createOscillator();osc.frequency.value=${mode === 'target' ? 440 : 880};const gain=ac.createGain();gain.gain.value=.025;osc.connect(gain).connect(ac.destination);osc.start();ac.resume();`,
      );
      console.log(
        'tone-ready:' +
          JSON.stringify({
            pid: process.pid,
            id: 'window:' + win.getNativeWindowHandle().readBigUInt64LE().toString() + ':0',
          }),
      );
      return;
    }
    const sources = [];
    for (const tone of ['target', 'other']) {
      const child = spawn(
        process.execPath,
        [fixturePath, '--audio-profile=' + profile, '--mode=' + tone],
        {
          env: { ...process.env },
          windowsHide: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let output = '';
      sources.push(
        await new Promise((resolve, reject) => {
          child.stdout.on('data', (data) => {
            output += String(data);
            const ready = output.match(/tone-ready:(\{[^\r\n]+\})/);
            if (ready) resolve(JSON.parse(ready[1]));
          });
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error('Synthetic tone process exited: ' + code)));
          child.stderr.on('data', (data) => process.stderr.write(data));
        }),
      );
    }
    stage = 'window identity resolution';
    const nativeSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const ownedSource = nativeSources.find(
      (source) => source.id.split(':')[1] === sources[0].id.split(':')[1],
    );
    assert.ok(ownedSource, 'Owned test window must be visible in the native source list.');
    const identities = await applicationAudioSources(
      sources.map((source) => source.id),
      AbortSignal.timeout(10000),
    );
    const audioId = identities.get(sources[0].id)?.applicationAudioId;
    assert.equal(
      audioId,
      'applicationLoopback:' + sources[0].pid,
      'Selected window must resolve to its own process.',
    );
    assert.notEqual(identities.get(sources[1].id)?.applicationAudioId, audioId);
    let nativeAudioRequested;
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      nativeAudioRequested = request.audioRequested;
      callback({
        video: { id: sources[0].id, name: 'Owned synthetic source' },
        audio: audioId,
      });
    });
    stage = 'Chromium capture';
    const result = await win.webContents.executeJavaScript(
      `(async()=>{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',windowAudio:'window',selfBrowserSurface:'exclude',surfaceSwitching:'exclude'});
    const ac=new AudioContext({sampleRate:48000});await ac.resume();
    const analyser=ac.createAnalyser();analyser.fftSize=8192;
    ac.createMediaStreamSource(stream).connect(analyser);
    await new Promise(resolve=>setTimeout(resolve,2500));
    const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);
    const level=frequency=>Math.max(...bins.slice(Math.round(frequency/ac.sampleRate*analyser.fftSize)-2,Math.round(frequency/ac.sampleRate*analyser.fftSize)+3));
    const result={audioTracks:stream.getAudioTracks().length,targetDb:level(440),otherDb:level(880),surface:stream.getVideoTracks()[0].getSettings().displaySurface};
    stream.getTracks().forEach(track=>track.stop());result.stopped=stream.getTracks().every(track=>track.readyState==='ended');await ac.close();return result;
  })().catch(error=>({captureError:error.name+': '+error.message}))`,
      true,
    );
    if (result.captureError) throw new Error(result.captureError);
    assert.equal(
      nativeAudioRequested,
      true,
      'The production options must request audio from Electron.',
    );
    assert.equal(result.audioTracks, 1);
    assert.equal(result.surface, 'window');
    assert.ok(
      result.targetDb > -90,
      'Synthetic target tone must be present; check test playback volume if silent.',
    );
    assert.ok(result.targetDb - result.otherDb > 30, 'Unselected process tone must be excluded.');
    assert.equal(result.stopped, true);
    const report = {
      runtime: process.versions.electron,
      chromium: process.versions.chrome,
      ...result,
      scope:
        'Owned synthetic app processes and source windows only; no microphone, private desktop, WAN or human playback acceptance.',
    };
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await writeFile(
      path.join(root, 'artifacts/application-audio-smoke.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    clearTimeout(deadline);
    cleanup();
    app.quit();
  })
  .catch((error) => {
    console.error(
      'Application audio fixture failed at ' + stage + ':',
      String(error),
      JSON.stringify(error),
      error?.stack || '',
      error?.stderr || '',
    );
    cleanup();
    app.exit(1);
  });
