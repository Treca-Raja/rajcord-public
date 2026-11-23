import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from '../app.js';
import { AuthService } from '../auth/service.js';
import { testDatabase } from '../db/test-database.js';
import { launch, setup, type Browser } from '../voice/browser-harness.js';
import { checkVoiceTestServices } from '../voice/test-services.js';

const origin = 'http://127.0.0.1:3002';
const room = process.argv.includes('--voice-room');
const viewerArg = process.argv.find((arg) => arg.startsWith('--viewers='));
const watchCount = viewerArg ? Number(viewerArg.split('=')[1]) : room ? 2 : 1;
assert(Number.isInteger(watchCount) && watchCount >= 1 && watchCount <= (room ? 9 : 1));
assert(watchCount <= 2 || process.env.RAJCORD_SCREEN_BENCH_VIDEO, 'Select moving gameplay.');
const crashHelper = process.argv.includes('--crash-helper');
const logout = process.argv.includes('--logout');
const revoke = process.argv.includes('--revoke');
const endSource = process.argv.includes('--end-source');
const fixtureBundle = process.env.RAJCORD_SCREEN_BENCH_BUNDLE
  ? path.resolve(process.env.RAJCORD_SCREEN_BENCH_BUNDLE)
  : undefined;
assert([crashHelper, logout, revoke, endSource].filter(Boolean).length <= 1);
const config = await checkVoiceTestServices();
const fixture = await testDatabase();
const prefix = 'obs-app-' + randomUUID() + '-';
const server = createApp({
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
  voiceConfig: { ...config, prefix },
});
const profile = await mkdtemp(path.join(tmpdir(), 'rajcord-obs-app-'));
const browsers: Browser[] = [];
let source: ReturnType<typeof spawn> | undefined;
let desktop: ReturnType<typeof spawn> | undefined;
try {
  await server.app.listen({ host: '127.0.0.1', port: 3002 });
  const auth = new AuthService(fixture.database.pool);
  const password = randomUUID() + 'Aa3!';
  await auth.bootstrap('obs_publisher', 'Native publisher', password);
  const owner = await auth.login(
    { username: 'obs_publisher', password, remember: false },
    undefined,
  );
  for (let index = 0; index < (room ? 9 : 1); index++) {
    const username = 'obs_viewer_' + index;
    const guest = await auth.register({
      username,
      displayName: 'Room participant ' + index,
      password,
    });
    await auth.changeStatus(owner.token, guest.id, 'approve');
    const viewer = await auth.login({ username, password, remember: false }, undefined);
    const browser = await launch({
      rajcordDesktop: !process.argv.includes('--edge-viewer'),
      loopbackIce: true,
      roomWindow: room ? (index === 0 ? 'left' : index === 1 ? 'right' : 'background') : undefined,
    });
    browsers.push(browser);
    await setup(browser, viewer.token, origin);
    if (room && index < 2)
      await browser.js(`document.querySelector('button[aria-label="Unmute microphone"]')?.click()`);
    if (index < watchCount) {
      await browser.js("document.querySelector('.screen-launcher > button').click()");
      await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
    }
  }
  const title = 'Rajcord WGC fixture ' + randomUUID();
  const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
  const sourceProfile = await mkdtemp(path.join(profile, 'window-'));
  source = spawn(
    require('electron'),
    [fileURLToPath(new URL('../../../desktop/dist/obs-source-smoke.js', import.meta.url))],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: false,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        APPDATA: process.env.APPDATA,
        RAJCORD_TEST_WINDOW: title,
        TRICORD_TEST_PROFILE: sourceProfile,
        RAJCORD_SCREEN_BENCH_VIDEO: process.env.RAJCORD_SCREEN_BENCH_VIDEO,
      },
    },
  );
  const hwnd = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('The owned source window did not start.')),
      15000,
    );
    source!.once('message', (value) => {
      clearTimeout(timeout);
      resolve(String(value));
    });
    source!.once('error', reject);
  });
  assert.match(hwnd, /^[1-9]\d*$/);
  const env = {
    ...process.env,
    TRICORD_TEST_PROFILE: profile,
    RAJCORD_TEST_SESSION: owner.token,
    RAJCORD_TEST_WINDOW: title,
    RAJCORD_TEST_HWND: hwnd,
    RAJCORD_TEST_VOICE_ROOM: room ? '1' : '0',
    RAJCORD_SCREEN_BENCH_BUNDLE: fixtureBundle,
    TRICORD_VOICE_SMOKE: '1',
  };
  for (const key of Object.keys(env))
    if (/^(DATABASE_URL|LIVEKIT_|TRICORD_TURN)/.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  desktop = spawn(
    require('electron'),
    ['.', '--auth-smoke', '--native-screen-smoke', '--allow-loopback-in-peer-connection'],
    {
      cwd: fileURLToPath(new URL('../../../desktop/', import.meta.url)),
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    desktop!.once('exit', resolve);
    desktop!.once('error', reject);
  });
  const expected = (name: string) =>
    Promise.race([
      new Promise<void>((resolve) =>
        desktop!.once('message', (value) => {
          if (value === name) resolve();
        }),
      ),
      exited.then((code) => {
        throw new Error('Electron exited before ' + name + ' (' + code + ')');
      }),
    ]);
  await expected('published');
  const viewers = browsers.slice(0, watchCount);
  const stats = (browser: Browser) =>
    browser.js(`(async()=>{
    for(const pc of window.__peers) {
      const report = await pc.getStats();
      for(const item of report.values()) {
        if(item.type !== 'inbound-rtp' || item.kind !== 'video' || !item.framesDecoded) continue;
        const pair = report.get(report.get(item.transportId)?.selectedCandidatePairId);
        return {
          codec:report.get(item.codecId)?.mimeType, decoded:item.framesDecoded,
          width:item.frameWidth, height:item.frameHeight, fps:item.framesPerSecond, bytes:item.bytesReceived,
          local:report.get(pair?.localCandidateId)?.candidateType,
          remote:report.get(pair?.remoteCandidateId)?.candidateType
        };
      }
    }
  })()`) as Promise<{
      codec: string;
      decoded: number;
      width: number;
      height: number;
      fps: number;
      bytes: number;
      local: string;
      remote: string;
    }>;
  const joinMs = await Promise.all(
    viewers.map(async (browser) => {
      if (browser.rajcordDesktop) await browser.call('Page.bringToFront');
      await browser.wait("!!document.querySelector('.screen-share-item .screen-share-action')");
      const started = performance.now();
      await browser.js("document.querySelector('.screen-share-item .screen-share-action').click()");
      await browser.wait(
        "document.querySelector('[data-screen-playback]')?.getVideoPlaybackQuality().totalVideoFrames > 30",
      );
      return performance.now() - started;
    }),
  );
  const received = await Promise.all(viewers.map(stats));
  const receiver = await viewers[0]!.js('navigator.userAgent');
  console.log('Receiver', receiver);
  for (const sample of received) {
    assert.equal(sample.codec.toLowerCase(), 'video/h264');
    assert.ok(
      ['host', 'srflx', 'prflx'].includes(sample.local) &&
        ['host', 'srflx', 'prflx'].includes(sample.remote),
    );
  }
  let measured: { sourceFps?: number; windows: number[][] } | undefined;
  if (room) {
    const frames = () =>
      Promise.all(
        viewers.map(
          (browser) =>
            browser.js(
              `(()=>{const q=document.querySelector('[data-screen-playback]').getVideoPlaybackQuality();return q.totalVideoFrames-q.droppedVideoFrames})()`,
            ) as Promise<number>,
        ),
      );
    const voice = () =>
      Promise.all(
        browsers.map(
          (browser) =>
            browser.js(
              `Promise.all(window.__peers.map(pc=>pc.getStats())).then(reports=>reports.filter(report=>![...report.values()].some(item=>item.type==='inbound-rtp'&&item.kind==='video')).flatMap(report=>[...report.values()]).filter(item=>item.type==='inbound-rtp'&&item.kind==='audio').reduce((bytes,item)=>bytes+item.bytesReceived,0))`,
            ) as Promise<number>,
        ),
      );
    const sourceFrames = () =>
      !process.env.RAJCORD_SCREEN_BENCH_VIDEO
        ? Promise.resolve(0)
        : new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('The recording window did not report its frame count.')),
              3000,
            );
            source!.once('message', (value) => {
              clearTimeout(timeout);
              if (typeof value === 'number') resolve(value);
              else reject(new Error('Invalid source frame count.'));
            });
            source!.send('frames');
          });
    const voiceBefore = await voice();
    const beforeSource = await sourceFrames(),
      start = performance.now();
    let previous = await frames(),
      then = performance.now();
    const windows: number[][] = [];
    for (let i = 0; i < 12; i++) {
      await delay(4000);
      const next = await frames(),
        now = performance.now();
      windows.push(
        next.map((value, k) => Math.round(((value - previous[k]!) * 10000) / (now - then)) / 10),
      );
      previous = next;
      then = now;
    }
    measured = { windows };
    if (process.env.RAJCORD_SCREEN_BENCH_VIDEO) {
      const sourceFps =
        (((await sourceFrames()) - beforeSource) * 1000) / (performance.now() - start);
      measured.sourceFps = sourceFps;
      console.log('Recording playback FPS', Math.round(sourceFps * 10) / 10);
      assert.ok(sourceFps > 0, 'The recording must advance in the source window.');
    }
    console.log('Twelve four-second presented FPS windows', JSON.stringify(windows));
    assert.ok(
      windows.every((window) => window.every((fps) => fps > 0)),
      'Video must advance through lease renewal.',
    );
    const voiceAfter = await voice();
    assert.ok(
      voiceAfter.every((value, k) => value > voiceBefore[k]!),
      'Voice bytes must advance across the room.',
    );
  }
  if (!room) {
    const viewer = viewers[0]!;
    assert.equal(received[0]!.height, 720);
    assert.equal(await viewer.js("document.querySelectorAll('.screen-watch select').length"), 0);
    await viewer.js(
      "void (window.fixtureWatchedStream = document.querySelector('[data-screen-playback]').srcObject)",
    );
    for (const [action, height, frameRate] of [
      ['reduce-quality', 480, 15],
      ['raise-quality', 1080, 60],
    ] as const) {
      const updated = expected('quality-applied');
      desktop!.send(action);
      await updated;
      try {
        await viewer.wait(
          `document.querySelector('[data-screen-playback]')?.videoHeight === ${height}`,
        );
        await viewer.wait(`(async()=>{for(const pc of window.__peers) {
          const report=await pc.getStats();
          for(const item of report.values()) if(item.type==='inbound-rtp'&&item.kind==='video'&&
            item.frameHeight===${height}&&item.framesPerSecond>=${frameRate - 2}&&item.framesPerSecond<=${frameRate + 1}) return true;
        }return false})()`);
      } catch (cause) {
        throw new Error(
          'Native publisher quality update failed to reach the receiver. ' +
            JSON.stringify(await stats(viewer)),
          { cause },
        );
      }
      console.log('Live publisher quality', await stats(viewer));
      assert.equal(
        await viewer.js(
          "document.querySelector('[data-screen-playback]').srcObject === window.fixtureWatchedStream",
        ),
        true,
      );
    }
    await viewer.click('Stop watching');
    await viewer.wait("!document.querySelector('[data-screen-playback]')");
    await viewer.wait("!!document.querySelector('.screen-share-item .screen-share-action')");
    await viewer.js("document.querySelector('.screen-share-item .screen-share-action').click()");
    await viewer.wait(
      "document.querySelector('[data-screen-playback]')?.videoHeight === 1080 && document.querySelector('[data-screen-playback]').getVideoPlaybackQuality().totalVideoFrames>10",
    );
  }
  assert(desktop.pid);
  const executable = path.join(
    fixtureBundle ??
      fileURLToPath(new URL('../../../desktop/native/obs/dist/bundle', import.meta.url)),
    'bin/rajcord-obs.exe',
  );
  const { stdout } = await promisify(execFile)(
    path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${desktop.pid} AND Name="rajcord-obs.exe"' | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 5000 },
  );
  const helper = JSON.parse(stdout) as { ProcessId: number; ExecutablePath: string };
  assert.equal(path.normalize(helper.ExecutablePath).toLowerCase(), executable.toLowerCase());
  const stopped = expected('stopped');
  if (crashHelper) {
    process.kill(helper.ProcessId);
    desktop.send('helper-ended');
  } else if (endSource) {
    source.kill();
    desktop.send('source-ended');
  } else if (revoke) {
    await fixture.database.pool.query(
      'UPDATE sessions SET revoked_at=now() WHERE user_id=(SELECT id FROM users WHERE username=$1)',
      ['obs_publisher'],
    );
    desktop.send('revoked');
  } else if (logout) {
    desktop.send('logout');
  } else desktop.send('stop');
  await stopped;
  for (const browser of viewers)
    await browser.wait("!document.querySelector('[data-screen-playback]')");
  for (const browser of browsers)
    assert.equal(
      await browser.js("document.querySelector('[data-voice-status]').dataset.voiceStatus"),
      'connected',
    );
  const helperRunning = () => {
    try {
      process.kill(helper.ProcessId, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return false;
    }
  };
  const deadline = performance.now() + 3000;
  while (helperRunning() && performance.now() < deadline) await delay(100);
  assert.equal(helperRunning(), false, 'The OBS helper must exit after publication ends.');
  desktop.send('finish');
  assert.equal(await exited, 0);
  if (measured) {
    const directory = fileURLToPath(new URL('../../../../artifacts/screen/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const report = path.join(directory, 'desktop-room-' + Date.now() + '.json');
    await writeFile(
      report,
      JSON.stringify(
        {
          sender: 'obs',
          receiver,
          participants: 10,
          viewers: watchCount,
          joinMs,
          talkers: 2,
          received,
          ...measured,
        },
        null,
        2,
      ),
    );
    console.log(report);
  }
  console.log(
    'PASS authenticated Electron picker, OBS publisher, receiver playback, ' +
      (crashHelper
        ? 'native helper failure'
        : endSource
          ? 'source closure'
          : logout
            ? 'logout'
            : revoke
              ? 'revocation'
              : 'Stop') +
      ' and voice continuity',
    received,
  );
} finally {
  desktop?.kill();
  source?.kill();
  await Promise.all(browsers.map((browser) => browser.close()));
  await server.app.close();
  for (const room of await server.voice!.media.listRooms())
    if (room.name.startsWith(prefix)) await server.voice!.media.deleteRoom(room.name);
  await fixture.cleanup();
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
