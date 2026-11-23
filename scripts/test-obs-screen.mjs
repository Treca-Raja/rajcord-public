// Local Windows OBS benchmark with a fixture-owned capture window.
// Build the desktop source fixture, API browser harness, shared contracts and native helper first.
// RAJCORD_SCREEN_BENCH_VIDEO optionally selects a local video file.
// RAJCORD_SCREEN_BENCH_MARKER=1 measures marker-to-presentation latency with pixel readback.
// RAJCORD_SCREEN_BENCH_BUNDLE selects a staged or packaged OBS resource directory.
// RAJCORD_SCREEN_BENCH_RECEIVER selects visible Electron windows (default) or headless Edge.
// RAJCORD_SCREEN_BENCH_IMPAIRMENT=1 uses the owned loopback TURN fixture with one native viewer.
// RECOVERY=1 and VIEWER_ISOLATION=1 measure bitrate recovery for one shaped and one direct viewer.
// SHARED_UPLOAD=1 shares the relay fixture's bitrate cap across two or three viewers.
// For a live game, set RAJCORD_SCREEN_BENCH_DOOM and RAJCORD_SCREEN_BENCH_IWAD to
// Chocolate Doom and Freedoom 2. The default game metric is the engine's timedemo FPS.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchFreedoom } from './screen-freedoom-fixture.mjs';
import { bindLocalRelay } from './screen-loopback-relay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const env = process.env;
const fixtureRoot = path.join(root, '.local');
const script = fileURLToPath(import.meta.url);
const profile = env.RAJCORD_SCREEN_BENCH_PROFILE;
const seconds = Number(env.RAJCORD_SCREEN_BENCH_SECONDS ?? 20);
const counts = (env.RAJCORD_SCREEN_BENCH_VIEWERS ?? '1,2,3').split(',').map(Number);
const bitrate = Number(env.RAJCORD_SCREEN_BENCH_BITRATE ?? 12000000);
const liveGame = Boolean(env.RAJCORD_SCREEN_BENCH_DOOM);
const recording = env.RAJCORD_SCREEN_BENCH_RECORD;
const gameCapture = env.RAJCORD_OBS_GAME_CAPTURE_TEST === '1';
const windowLifecycle = env.RAJCORD_SCREEN_BENCH_WINDOW_LIFECYCLE === '1';
const indexed = env.RAJCORD_SCREEN_BENCH_INDEXED === '1';
assert(!indexed || (env.RAJCORD_SCREEN_BENCH_VIDEO && env.RAJCORD_SCREEN_BENCH_MARKER === '1'));
const expectUnpadded = env.RAJCORD_SCREEN_BENCH_EXPECT_UNPADDED === '1';
assert(!expectUnpadded || (!liveGame && !env.RAJCORD_SCREEN_BENCH_VIDEO));
const receiver = env.RAJCORD_SCREEN_BENCH_RECEIVER ?? 'electron';
assert(['electron', 'edge'].includes(receiver));
assert(!gameCapture || liveGame, 'OBS Game Capture requires the owned Freedoom fixture.');
const isolation = env.RAJCORD_SCREEN_BENCH_VIEWER_ISOLATION === '1';
const recovery = env.RAJCORD_SCREEN_BENCH_RECOVERY === '1';
const sharedUpload = env.RAJCORD_SCREEN_BENCH_SHARED_UPLOAD === '1';
const gradualRecovery = env.RAJCORD_SCREEN_BENCH_RECOVERY_RAMP === '1';
assert(!gradualRecovery || recovery || sharedUpload);
const voicePort = Number(env.RAJCORD_SCREEN_BENCH_SHARED_VOICE_PORT ?? 0);
assert(!voicePort || sharedUpload, 'Shared voice requires the shared-upload fixture.');
const impairment =
  isolation || recovery || sharedUpload || env.RAJCORD_SCREEN_BENCH_IMPAIRMENT === '1';
const coturn = env.RAJCORD_SCREEN_BENCH_COTURN;
assert(!coturn || ['udp', 'tcp', 'tls'].includes(coturn));
assert(!coturn || (!impairment && !liveGame && !windowLifecycle));
const relayOnly = impairment || Boolean(coturn);
if (impairment)
  assert(
    !liveGame &&
      (sharedUpload
        ? !isolation && counts.every((n) => n > 1)
        : counts.join() === (isolation ? '2' : '1')),
  );
if (recovery || sharedUpload)
  assert(env.RAJCORD_SCREEN_BENCH_VIDEO, 'Select a moving video recording.');
if (recording) assert(liveGame && counts.join() === '1' && receiver === 'electron');
if (windowLifecycle)
  assert(!liveGame && !impairment && counts.join() === '1' && !env.RAJCORD_SCREEN_BENCH_VIDEO);
assert(
  !liveGame ||
    (!env.RAJCORD_SCREEN_BENCH_VIDEO && env.RAJCORD_SCREEN_BENCH_MARKER !== '1' && seconds <= 40),
  'Freedoom uses its original demo with no video or marker override, up to 40 seconds.',
);
assert(process.platform === 'win32' && seconds >= 5 && seconds <= 180);
assert(counts.every((count) => [1, 2, 3].includes(count)));
assert([2000000, 4000000, 6000000, 8000000, 12000000, 20000000].includes(bitrate));

async function launchFixture() {
  await mkdir(fixtureRoot, { recursive: true });
  const owned = await mkdtemp(path.join(fixtureRoot, 'obs-benchmark-'));
  try {
    const childEnv = {
      ...env,
      RAJCORD_SCREEN_BENCH_PROFILE: owned,
      RAJCORD_SCREEN_BENCH_NODE: process.execPath,
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(requireDesktop('electron'), [script], { env: childEnv, stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
  } finally {
    assert.equal(path.dirname(owned), fixtureRoot);
    assert(path.basename(owned).startsWith('obs-benchmark-'));
    await rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

// This function runs inside a sandboxed page in either Edge or Electron.
function installPeers() {
  const peers = [];
  let configuration = { iceServers: [], bundlePolicy: 'max-bundle' };
  const gather = (pc) =>
    new Promise((resolve, reject) => {
      const relayOnly = configuration.iceTransportPolicy === 'relay';
      const end = setTimeout(
        () =>
          reject(
            new Error(
              'ICE gathering timed out without a usable ' +
                (relayOnly ? 'relay candidate' : 'description'),
            ),
          ),
        relayOnly ? 20000 : 7500,
      );
      function complete() {
        const relayReady =
          relayOnly && /a=candidate:[^\r\n]* typ relay\b/.test(pc.localDescription?.sdp ?? '');
        if (pc.iceGatheringState === 'complete' || relayReady) {
          clearTimeout(end);
          pc.removeEventListener('icegatheringstatechange', complete);
          pc.removeEventListener('icecandidate', complete);
          resolve();
        }
      }
      pc.addEventListener('icegatheringstatechange', complete);
      pc.addEventListener('icecandidate', complete);
      complete();
    });
  const peer = (id) => {
    const pc = new RTCPeerConnection(configuration);
    peers[id] = pc;
    return pc;
  };
  let gaps = [],
    previous,
    presented = 0,
    firstFrame = false;
  const video = document.querySelector('video');
  let marker,
    indexedMarker = false,
    readableMarkers = 0,
    priorStamp,
    duplicates = 0;
  const markerLatency = [];
  const markerIds = new Set();
  const frame = (_now, meta) => {
    if (previous !== undefined) gaps.push(meta.expectedDisplayTime - previous);
    previous = meta.expectedDisplayTime;
    firstFrame = true;
    presented = meta.presentedFrames;
    if (marker) {
      marker.drawImage(video, 0, 0, 320, 10, 0, 0, 320, 10);
      const pixels = marker.getImageData(0, 5, 320, 1).data;
      let word = 0;
      for (let bit = 0; bit < 32; bit++) {
        if (pixels[(bit * 10 + 5) * 4] > 128) word = (word | (1 << bit)) >>> 0;
      }
      const stamp = word & 0xffffff;
      if (word >>> 24 === ((stamp ^ (stamp >> 8) ^ (stamp >> 16) ^ 0xa5) & 255)) {
        const now = Math.round(performance.timeOrigin + meta.expectedDisplayTime);
        const elapsed = (now - stamp + 0x1000000) & 0xffffff;
        if (indexedMarker || elapsed < 10000) {
          if (!indexedMarker) markerLatency.push(elapsed);
          readableMarkers++;
          markerIds.add(stamp);
          if (stamp === priorStamp) duplicates++;
          priorStamp = stamp;
        }
      }
    }
    video.requestVideoFrameCallback(frame);
  };
  video.requestVideoFrameCallback(frame);
  function sampleVideo() {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 9;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, 0, 0, 16, 9);
    return context.getImageData(0, 0, 16, 9).data;
  }
  window.bench = {
    gameImage() {
      let hash = 1;
      for (const byte of sampleVideo()) hash = Math.imul(hash, 31) + byte;
      return hash >>> 0;
    },
    windowImage() {
      const data = sampleVideo();
      const centre = (4 * 16 + 8) * 4;
      const edge = 4 * 16 * 4;
      return {
        showsSource: data[centre] > 64 || data[centre + 2] > 64,
        darkEdge: Math.max(...data.subarray(edge, edge + 3)) < 32,
        blank: !data.some((value, index) => index % 4 !== 3 && value > 32),
      };
    },
    useRelay(config) {
      configuration = { ...config, bundlePolicy: 'max-bundle' };
    },
    resetPeer() {
      peers[0]?.close();
      peers.length = 0;
      video.srcObject = null;
      firstFrame = false;
    },
    enableMarker(indexed) {
      indexedMarker = indexed;
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 10;
      marker = canvas.getContext('2d', { willReadFrequently: true });
    },
    async answer(sdp) {
      const pc = peer(0);
      pc.ontrack = ({ track }) => {
        video.srcObject = new MediaStream([track]);
        void video.play();
      };
      await pc.setRemoteDescription({ type: 'offer', sdp });
      pc.getTransceivers().forEach((tx) => {
        tx.direction = 'recvonly';
      });
      await pc.setLocalDescription(await pc.createAnswer());
      await gather(pc);
      return pc.localDescription.sdp;
    },
    ice: (candidate) => peers[0].addIceCandidate(candidate),
    first: () => firstFrame,
    record(duration) {
      return new Promise((resolve, reject) => {
        const recorder = new MediaRecorder(video.srcObject, {
          mimeType: 'video/webm;codecs=vp8',
          videoBitsPerSecond: 12000000,
        });
        recorder.onerror = () => reject(new Error('Could not record the fixture stream.'));
        recorder.ondataavailable = ({ data }) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(data);
        };
        recorder.start();
        setTimeout(() => recorder.stop(), duration);
      });
    },
    async stats(id) {
      const stats = await peers[id].getStats();
      const inbound = [...stats.values()].find(
        (item) => item.type === 'inbound-rtp' && item.kind === 'video',
      );
      const transport = [...stats.values()].find((item) => item.type === 'transport');
      const pair = stats.get(transport?.selectedCandidatePairId);
      if (inbound)
        return {
          time: performance.now(),
          presented,
          gaps: gaps.splice(0),
          markerLatency: markerLatency.splice(0),
          readableMarkers,
          distinctMarkers: (() => {
            const distinct = markerIds.size;
            markerIds.clear();
            return distinct;
          })(),
          duplicates,
          width: inbound.frameWidth,
          height: inbound.frameHeight,
          decoded: inbound.framesDecoded,
          dropped: inbound.framesDropped,
          received: inbound.framesReceived,
          freezes: inbound.freezeCount,
          freezeSeconds: inbound.totalFreezesDuration,
          lost: inbound.packetsLost,
          retransmitted: inbound.retransmittedPacketsReceived,
          jitterMs: inbound.jitter * 1000,
          jitterBufferSeconds: inbound.jitterBufferDelay,
          jitterBufferFrames: inbound.jitterBufferEmittedCount,
          bytes: inbound.bytesReceived,
          decoder: inbound.decoderImplementation,
          codec: stats.get(inbound.codecId)?.mimeType,
          pairId: pair?.id,
          ice: pair && [
            stats.get(pair.localCandidateId)?.candidateType,
            stats.get(pair.remoteCandidateId)?.candidateType,
          ],
        };
    },
    stop() {
      for (const pc of peers) pc?.close();
    },
  };
}

async function launchBenchmarkSource() {
  const directory = await mkdtemp(path.join(profile, 'source-'));
  const childEnv = {
    ...env,
    TRICORD_TEST_PROFILE: directory,
    RAJCORD_TEST_WINDOW: 'Rajcord WGC fixture ' + crypto.randomUUID(),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.execPath,
    [path.join(root, 'apps/desktop/dist/obs-source-smoke.js')],
    {
      env: childEnv,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit');
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      await ended;
    } finally {
      clearTimeout(timer);
    }
  };
  const reply = () => once(child, 'message', { signal: AbortSignal.timeout(12000) });
  try {
    const [hwnd] = await reply();
    assert(/^\d+$/.test(hwnd) && child.pid);
    const { stdout } = await promisify(execFile)(
      path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -Namespace Bench -Name Window -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, [System.Runtime.InteropServices.Out] int[] rect); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);'; [void][Bench.Window]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)); $rect=New-Object int[] 4; if(-not [Bench.Window]::GetWindowRect([IntPtr]::new([int64]${hwnd}),$rect)){exit 1}; (Get-Process -Id ${child.pid}).StartTime.ToUniversalTime().Ticks; $rect`,
      ],
      { windowsHide: true, timeout: 5000 },
    );
    const [ticks, ...rect] = stdout.trim().split(/\s+/);
    assert(/^\d{15,20}$/.test(ticks) && rect.length === 4 && rect.every((v) => /^-?\d+$/.test(v)));
    const [left, top, right, bottom] = rect.map(Number);
    return {
      target: [hwnd, 'identity', String(child.pid), ticks],
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      close,
      async windowCommand(command) {
        const response = reply();
        child.send(command);
        return (await response)[0];
      },
      async quality() {
        const response = reply();
        child.send('frames');
        const [frames] = await response;
        assert(Number.isSafeInteger(frames) && frames >= 0);
        return { frames, time: performance.now() };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function sharedVoice(target, proxy) {
  const child = spawn(
    env.RAJCORD_SCREEN_BENCH_NODE,
    [
      path.join(root, 'apps/api/dist/screen/shared-voice-fixture.js'),
      '--shared-upload',
      target,
      proxy,
    ],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true },
  );
  const exited = once(child, 'exit');
  const receive = async (timeout) => {
    const [result] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(timeout) }),
      exited.then(([code]) => {
        throw new Error('The shared voice fixture exited (' + code + ').');
      }),
    ]);
    if (result.error) throw new Error(result.error);
    return result;
  };
  const close = async () => {
    if (child.connected) child.send('stop');
    const deadline = setTimeout(() => child.kill(), 12000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  };
  try {
    assert.equal((await receive(90000)).ready, true);
    return {
      async sample() {
        const pending = receive(6000);
        child.send('sample');
        return (await pending).sample;
      },
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

function cpuTimes() {
  return cpus().reduce(
    ([idle, total], cpu) => [
      idle + cpu.times.idle,
      total + Object.values(cpu.times).reduce((sum, v) => sum + v, 0),
    ],
    [0, 0],
  );
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    max: sorted.at(-1),
  };
}
const page =
  '<!doctype html><style>*{margin:0}video{width:100vw;height:100vh}</style><video muted autoplay playsinline></video><script>(' +
  installPeers.toString() +
  ')()</script>';

const bundle =
  env.RAJCORD_SCREEN_BENCH_BUNDLE ?? path.join(root, 'apps/desktop/native/obs/dist/bundle');
function nativeSender(target, onIce) {
  assert(path.isAbsolute(bundle), 'Select an absolute OBS bundle path.');
  const helper = path.join(bundle, 'bin/rajcord-obs.exe');
  const sha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const captureModule = gameCapture
    ? 'obs/core/win-capture/win-capture.dll'
    : 'bin/libobs-winrt.dll';
  const captureSha256 = createHash('sha256')
    .update(readFileSync(path.join(bundle, captureModule)))
    .digest('hex');
  const child = spawn(helper, [], {
    cwd: path.join(bundle, 'bin'),
    windowsHide: true,
    env: {
      SystemRoot: env.SystemRoot,
      LOCALAPPDATA: env.LOCALAPPDATA,
      TEMP: env.TEMP,
      TMP: env.TMP,
      PATH: [path.join(bundle, 'bin'), path.join(env.SystemRoot, 'System32')].join(path.delimiter),
      RAJCORD_OBS_DIAGNOSTICS: '1',
      ...(relayOnly && { RAJCORD_NATIVE_TEST_RELAY: '1' }),
      ...(env.RAJCORD_WGC_TEST_STOCK === '1' && { RAJCORD_WGC_TEST_STOCK: '1' }),
      ...(gameCapture && { RAJCORD_OBS_GAME_CAPTURE_TEST: '1' }),
      RAJCORD_OBS_ENCODER: env.RAJCORD_OBS_ENCODER ?? 'auto',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const requests = new Map();
  const captured = [],
    arrivals = [],
    renderUpdates = [],
    encoded = new Map(),
    encoders = new Map(),
    timing = new Map();
  let seq = 0,
    lastTime,
    failure;
  const decode = (v) => Buffer.from(v ?? '', 'base64').toString('utf8');
  const encode = (v) => Buffer.from(v, 'utf8').toString('base64');
  const fail = (err) => {
    failure = err;
    for (const pending of requests.values()) pending.reject(err);
    requests.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', () => fail(failure ?? new Error('OBS helper exited.')));
  createInterface({ input: child.stderr }).on('line', (line) => {
    if (env.RAJCORD_SCREEN_BENCH_DIAGNOSTICS === '1') console.error(line);
    const capture = /capture_ms=(\d+) captured=(\d+)/.exec(line);
    const wgc = /wgc_ms=(\d+) arrivals=(\d+) rendered_updates=(\d+)/.exec(line);
    if (wgc) {
      arrivals.push([Number(wgc[1]), Number(wgc[2])]);
      renderUpdates.push([Number(wgc[1]), Number(wgc[3])]);
    }
    const link = /link=(\S+) encoder=(\S+) encoded=(\d+)/.exec(line);
    if (capture) {
      lastTime = Number(capture[1]);
      const gaps = /capture_p95_ms=([\d.]+) capture_p99_ms=([\d.]+)/.exec(line);
      captured.push([lastTime, Number(capture[2]), ...(gaps ? gaps.slice(1).map(Number) : [])]);
    }
    const obsTiming = /obs_timing link=(\S+) video_timeline_to_packet_us=(\d+)/.exec(line);
    if (obsTiming && Number(obsTiming[2]) > 0) {
      if (!timing.has(obsTiming[1])) timing.set(obsTiming[1], []);
      timing.get(obsTiming[1]).push(Number(obsTiming[2]) / 1000);
    }
    if (link) {
      if (!encoded.has(link[1])) encoded.set(link[1], []);
      encoders.set(link[1], link[2]);
      const gaps = /encode_p95_ms=([\d.]+) encode_p99_ms=([\d.]+)/.exec(line);
      encoded
        .get(link[1])
        .push([lastTime, Number(link[3]), ...(gaps ? gaps.slice(1).map(Number) : [])]);
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const [type, id, value, data] = line.split('\t');
    if (type === 'FATAL') return fail(new Error(decode(id)));
    if (type === 'ICE') return onIce(id, Number(value), decode(data));
    if (type === 'STATE') {
      if (env.RAJCORD_SCREEN_BENCH_DIAGNOSTICS === '1') console.error(`Viewer ${id}: ${value}`);
      return;
    }
    const pending = requests.get(id);
    if (!pending) return;
    requests.delete(id);
    if (type === 'ERROR') pending.reject(new Error(decode(value)));
    else pending.resolve(decode(value));
  });
  function request(...args) {
    if (failure) return Promise.reject(failure);
    const id = String(++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('Native timeout: ' + args[0]));
      }, 12000);
      requests.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write([id, ...args].join('\t') + '\n');
    });
  }
  return {
    sha256,
    captureSha256,
    start: () => request('start', 'window', ...target),
    async offer(id, turn, restart = false) {
      const uris = turn ? [encode(turn)] : [];
      const sdp = await request(restart ? 'restart' : 'open', id, 1920, 1080, 60, bitrate, ...uris);
      await request('local', id, encode(sdp));
      return sdp;
    },
    accept: (id, answer) => request('answer', id, encode(answer)),
    closeViewer: (id) => request('close', id),
    reset: () => {
      captured.length = 0;
      arrivals.length = 0;
      renderUpdates.length = 0;
      encoded.clear();
      timing.clear();
    },
    samples: () => ({ captured, arrivals, renderUpdates, encoded, encoders, timing }),
    async expectSourceEnd() {
      if (child.exitCode === null && child.signalCode === null)
        await once(child, 'close', { signal: AbortSignal.timeout(5000) });
      assert.match(failure?.message ?? '', /selected native (?:window|screen source) ended/i);
    },
    async stop() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      const deadline = setTimeout(() => child.kill(), 1500);
      try {
        child.stdin.end();
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

function rate(samples) {
  const first = samples?.[0],
    last = samples?.at(-1);
  return first && last && last[0] > first[0]
    ? ((last[1] - first[1]) * 1000) / (last[0] - first[0])
    : null;
}

async function run() {
  const { app, BrowserWindow, screen, session } = await import('electron');
  app.setPath('userData', profile);
  if (relayOnly) app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();
  const { launch } = await import('../apps/api/dist/voice/browser-harness.js');
  const shared = await import('../packages/shared/dist/index.js');
  const server = createServer((req, res) => {
    if (req.url !== '/fixture') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  });
  const reports = [];
  let tlsRelay;
  let coturnServers;
  let ownedSource;
  let separateSourceDisplay = false;
  let displayTiming;
  let sourceAlone;
  const viewers = [];
  const output = path.join(root, 'artifacts/screen', 'obs-' + Date.now() + '.json');
  const persist = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          bitrate,
          seconds,
          source: liveGame
            ? 'Chocolate Doom / Freedoom 2 DEMO2'
            : env.RAJCORD_SCREEN_BENCH_VIDEO
              ? 'recording'
              : 'synthetic-motion',
          signaling: 'fixture loopback',
          coturn,
          marker: env.RAJCORD_SCREEN_BENCH_MARKER === '1',
          markerEncoding: indexed ? 'source frame id' : 'source clock',
          wgcStockIntervalRequested: env.RAJCORD_WGC_TEST_STOCK === '1',
          receiver,
          separateSourceDisplay,
          displayTiming,
          electronVersion: process.versions.electron,
          chromiumVersion: process.versions.chrome,
          nativeVersion: /^libdatachannel (\S+)/m.exec(
            readFileSync(path.join(bundle, 'versions.txt'), 'utf8'),
          )?.[1],
          sourceAlone,
          reports,
        },
        null,
        2,
      ),
    );
  };
  try {
    if (coturn) {
      const secret = env.SCREEN_COTURN_SECRET;
      assert(secret && /^[a-f0-9]{64}$/.test(secret), 'An isolated coturn fixture is required.');
      const { screenRelayServers } = await import('../apps/api/dist/screen/relay.js');
      coturnServers = (identity) =>
        screenRelayServers(
          { screenCoturn: { host: 'localhost', secret } },
          identity,
          Date.now(),
        )[1];
      if (coturn === 'tls') {
        const { openTurnTls } = await import('../apps/desktop/dist/obs-turn-tls.js');
        tlsRelay = await openTurnTls('localhost', 5350);
      }
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const primary = screen.getPrimaryDisplay();
    const secondary = screen
      .getAllDisplays()
      .find(
        (display) =>
          display.id !== primary.id &&
          display.bounds.width >= 1920 &&
          display.bounds.height >= 1080,
      );
    const receiverDisplay = secondary || primary;
    separateSourceDisplay = Boolean(secondary && !liveGame);
    const displayStats = (display) => ({
      width: display.bounds.width,
      height: display.bounds.height,
      refreshHz: display.displayFrequency,
      scaleFactor: display.scaleFactor,
    });
    displayTiming = {
      receiver: displayStats(receiverDisplay),
      ...(!liveGame && { recording: displayStats(primary) }),
    };
    const windowOptions = {
      width: 1920,
      height: 1080,
      frame: false,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    };
    const marker = env.RAJCORD_SCREEN_BENCH_MARKER === '1';
    if (!liveGame) {
      ownedSource = await launchBenchmarkSource();
      const actual = screen.getDisplayMatching(ownedSource.bounds);
      displayTiming.recording = displayStats(actual);
      separateSourceDisplay = actual.id !== receiverDisplay.id;
    }
    let target = ownedSource?.target;
    for (let i = 0; i < Math.max(...counts); i++) {
      if (receiver === 'electron') {
        const window = new BrowserWindow({
          ...windowOptions,
          show: false,
          width: 560,
          height: 315,
          x: receiverDisplay.workArea.x + 20 + 570 * i,
          y: receiverDisplay.workArea.y + 50,
          title: 'Rajcord benchmark viewer ' + (i + 1),
          webPreferences: {
            ...windowOptions.webPreferences,
            session: session.fromPartition('obs-viewer-' + i),
          },
        });
        const js = (code) => window.webContents.executeJavaScript(code);
        viewers.push({
          navigate: async (url) => {
            await window.loadURL(url);
            window.showInactive();
            assert(
              window.isVisible() &&
                screen.getDisplayMatching(window.getBounds()).id === receiverDisplay.id,
            );
          },
          wait: async (condition) => {
            const until = performance.now() + 15000;
            while (!(await js(condition))) {
              assert(performance.now() < until, 'Electron viewer timed out: ' + condition);
              await delay(100);
            }
          },
          js,
          close: () => window.destroy(),
        });
        continue;
      }
      const viewer = await launch({ fakeMicrophone: false });
      viewers.push({
        navigate: (url) => viewer.call('Page.navigate', { url }),
        wait: (condition) => viewer.wait(condition),
        js: (code) => viewer.js(code),
        close: () => viewer.close(),
      });
      await viewer.call('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const sourceQuality = async () =>
      env.RAJCORD_SCREEN_BENCH_VIDEO ? ownedSource.quality() : null;
    function playback(before, after) {
      return { fps: (1000 * (after.frames - before.frames)) / (after.time - before.time) };
    }
    if (env.RAJCORD_SCREEN_BENCH_VIDEO) {
      const start = await sourceQuality();
      await delay(5000);
      sourceAlone = playback(start, await sourceQuality());
    }
    for (const count of counts) {
      const current = viewers.slice(0, count);
      const byId = new Map();
      const iceTasks = [];
      let iceError;
      let native;
      let game;
      let network;
      let localRelay;
      let voice;
      const report = { sender: 'obs', capture: gameCapture ? 'game' : 'wgc', count };
      reports.push(report);
      const gpuSamples = [];
      let sampling = true,
        gpuTask;
      const sampleGpu = async () => {
        const exec = promisify(execFile);
        while (sampling) {
          try {
            const { stdout } = await exec(
              'nvidia-smi',
              [
                '--query-gpu=utilization.gpu,utilization.encoder,encoder.stats.sessionCount',
                '--format=csv,noheader,nounits',
              ],
              { windowsHide: true, timeout: 3000 },
            );
            const sample = stdout.trim().split(',').map(Number);
            if (sample.length === 3 && sample.every(Number.isFinite)) gpuSamples.push(sample);
          } catch {
            return;
          }
          if (sampling) await delay(1000);
        }
      };
      try {
        if (impairment) {
          const { createScreenNetworkFixture } =
            await import('../apps/api/dist/screen/network-fixture.js');
          network = await createScreenNetworkFixture();
          if (voicePort) {
            voice = await sharedVoice(voicePort, await network.voiceUpload(voicePort));
          }
          localRelay = await bindLocalRelay(network.configuration);
        }
        if (liveGame) {
          game = await launchFreedoom(profile);
          target = game.target;
          await game.until(1500);
          if (gameCapture) {
            const staleIdentity = [...target];
            staleIdentity[3] = String(BigInt(staleIdentity[3]) + 1n);
            const rejected = nativeSender(staleIdentity, () => {});
            try {
              await assert.rejects(rejected.start(), /selected window owner was replaced/i);
              report.rejectedStaleWindowIdentity = true;
            } finally {
              await rejected.stop();
            }
          }
        }
        await Promise.all(
          current.map(async (browser) => {
            await browser.navigate(origin + '/fixture');
            await browser.wait('!!window.bench');
            if (network && (!isolation || browser === current[0]))
              await browser.js('bench.useRelay(' + JSON.stringify(localRelay.configuration) + ')');
          }),
        );
        if (marker)
          await Promise.all(
            current.map((viewer) => viewer.js('bench.enableMarker(' + indexed + ')')),
          );
        native = nativeSender(target, (id, index, candidate) => {
          const link = byId.get(id);
          if (!link) return;
          if (link.relay) {
            const type = / typ (host|srflx|prflx|relay)\b/.exec(candidate)?.[1];
            if (type) {
              report.nativeCandidates ??= {};
              report.nativeCandidates[type] = (report.nativeCandidates[type] ?? 0) + 1;
            }
            if (type !== 'relay') return;
          }
          link.pending.push({ index, candidate });
          if (link.ready)
            iceTasks.push(
              link.flush().catch((err) => {
                iceError = err;
              }),
            );
        });
        const captureStarted = performance.now();
        await native.start();
        report.captureReadyMs = performance.now() - captureStarted;
        report.nativeHelperSha256 = native.sha256;
        report.obsCaptureSha256 = native.captureSha256;
        async function connect(viewer, linkId, previous) {
          const started = performance.now();
          const link = {
            relay: Boolean(coturn || (network && (!isolation || viewer === current[0]))),
            pending: [],
            ready: false,
            description: undefined,
            async flush() {
              for (const { index, candidate } of this.pending.splice(0)) {
                const dto = shared.parseScreenIce({
                  candidate,
                  sdpMLineIndex: index,
                  sdpMid: this.description.mids[index],
                  usernameFragment: this.description.ufrags[index],
                });
                await viewer.js('bench.ice(' + JSON.stringify(dto) + ')');
              }
            },
          };
          byId.set(linkId, link);
          const relay = link.relay && localRelay?.configuration.iceServers[0];
          let turn =
            relay &&
            relay.urls.replace('turn:', 'turn://' + relay.username + ':' + relay.credential + '@');
          if (coturnServers) {
            const publisher = coturnServers('video-publisher');
            const receiver = coturnServers('video-viewer-' + linkId);
            // Chromium uses UDP for this TLS case. The native publisher uses Rajcord's TLS bridge
            // and verifies the ephemeral fixture certificate through Node's extra CA roots.
            const urls = receiver.urls[coturn === 'tcp' ? 1 : 0].replace('localhost', '127.0.0.1');
            await viewer.js(
              'bench.useRelay(' +
                JSON.stringify({
                  iceServers: [{ ...receiver, urls }],
                  iceTransportPolicy: 'relay',
                }) +
                ')',
            );
            const username = encodeURIComponent(publisher.username);
            const password = encodeURIComponent(publisher.credential);
            link.turnUsername = publisher.username;
            turn = `turn://${username}:${password}@127.0.0.1:${tlsRelay?.port ?? 3479}?transport=${coturn === 'udp' ? 'udp' : 'tcp'}`;
          }
          const sdp = await native.offer(linkId, turn, !!previous);
          link.description = shared.parseScreenDescription(sdp, 'offer');
          if (previous) assert.notEqual(link.description.ufrags[0], previous.ufrags[0]);
          const answer = await viewer.js('bench.answer(' + JSON.stringify(sdp) + ')');
          shared.parseScreenDescription(answer, 'answer');
          await native.accept(linkId, answer);
          link.ready = true;
          await link.flush();
          await viewer.wait('bench.first()');
          return { firstFrameMs: performance.now() - started, description: link.description };
        }
        report.connectionMs = [];
        for (const viewer of current) {
          const connection = await connect(viewer, crypto.randomUUID());
          report.connectionMs.push(connection.firstFrameMs);
        }
        if (windowLifecycle) {
          const [viewer] = current;
          await viewer.wait('bench.windowImage().showsSource && !bench.windowImage().darkEdge');
          assert.equal(await ownedSource.windowCommand('focus-other'), true);
          await viewer.wait('bench.windowImage().showsSource');
          assert.deepEqual(await ownedSource.windowCommand('resize'), [1280, 960]);
          await viewer.wait('bench.windowImage().showsSource && bench.windowImage().darkEdge');
          assert.equal(await ownedSource.windowCommand('minimize'), true);
          await viewer.wait('bench.windowImage().blank');
          assert.equal(await ownedSource.windowCommand('restore'), true);
          await viewer.wait('bench.windowImage().showsSource && bench.windowImage().darkEdge');
          report.windowLifecycle = {
            focus: true,
            resize: true,
            minimizedBlank: true,
            restore: true,
          };
        }
        if (game) {
          const hashes = new Set();
          for (let i = 0; i < 5; i++) {
            hashes.add(await current[0].js('bench.gameImage()'));
            await delay(150);
          }
          report.distinctGameImages = hashes.size;
          assert(hashes.size >= 2, 'Receiver did not show changing game content.');
        }
        await delay(1500);
        if (game?.presentMon) await game.until(12000);
        const snapshot = () => Promise.all(current.map((browser) => browser.js('bench.stats(0)')));
        const initial = await snapshot();
        native.reset();
        const startQuality = await sourceQuality();
        const startCpu = cpuTimes();
        gpuTask = sampleGpu();
        const presents =
          game &&
          game.measure(seconds).then(
            (data) => ({ data }),
            (error) => ({ error }),
          );
        if (recording) {
          await writeFile(
            recording,
            Buffer.from(await current[0].js('bench.record(' + seconds * 1000 + ')'), 'base64'),
            { flag: 'wx' },
          );
        } else await delay(seconds * 1000);
        const end = await snapshot();
        const endCpu = cpuTimes();
        const endQuality = await sourceQuality();
        report.hostCpuPercent = 100 * (1 - (endCpu[0] - startCpu[0]) / (endCpu[1] - startCpu[1]));
        if (startQuality && endQuality) {
          report.sourcePlayback = playback(startQuality, endQuality);
          assert(
            report.sourcePlayback.fps >= sourceAlone.fps * 0.9,
            'Gameplay source fell below 90% of its unshared rate; the samples are not matched.',
          );
        }
        if (iceError) throw iceError;
        const samples = native.samples();
        report.viewers = end.map((s, i) => {
          const start = initial[i],
            secs = (s.time - start.time) / 1000;
          assert.equal(s.width, 1920);
          assert.equal(s.height, 1080);
          assert.equal(s.codec.toLowerCase(), 'video/h264');
          if (relayOnly && (!isolation || i === 0)) assert.deepEqual(s.ice, ['relay', 'relay']);
          else assert(s.ice?.every((type) => ['host', 'srflx', 'prflx'].includes(type)));
          assert(s.decoded > start.decoded && s.presented > start.presented);
          const gaps = s.gaps.sort((a, b) => a - b);
          const percentile = (p) => gaps[Math.min(gaps.length - 1, Math.ceil(p * gaps.length) - 1)];
          const key = [...byId.keys()][i];
          return {
            decodedFps: (s.decoded - start.decoded) / secs,
            presentedFps: (s.presented - start.presented) / secs,
            capturedFps: rate(samples.captured),
            encodedFps: rate(samples.encoded.get(key)),
            encoder: samples.encoders.get(key),
            videoTimelineToPacketMs: samples.timing.get(key) ?? [],
            captureMetric: 'OBS composed frames',
            wgcArrivalsFps: rate(samples.arrivals),
            wgcDistinctTexturesRenderedFps: rate(samples.renderUpdates),
            decoder: s.decoder,
            width: s.width,
            height: s.height,
            ice: s.ice,
            codec: s.codec,
            gapP95ms: percentile(0.95),
            gapP99ms: percentile(0.99),
            gapMaxMs: gaps.at(-1),
            nativeCadenceWindows: {
              captureP95MaxMs: summarize(
                samples.captured.filter((row) => row.length === 4).map((row) => row[2]),
              )?.max,
              captureP99MaxMs: summarize(
                samples.captured.filter((row) => row.length === 4).map((row) => row[3]),
              )?.max,
              encodeP95MaxMs: summarize(
                (samples.encoded.get(key) ?? [])
                  .filter((row) => row.length === 4)
                  .map((row) => row[2]),
              )?.max,
              encodeP99MaxMs: summarize(
                (samples.encoded.get(key) ?? [])
                  .filter((row) => row.length === 4)
                  .map((row) => row[3]),
              )?.max,
            },
            ...(marker && {
              markerReads: s.readableMarkers - start.readableMarkers,
              duplicateMarkers: s.duplicates - start.duplicates,
              distinctMarkerFps: s.distinctMarkers / secs,
              markerToDisplayMs: summarize(s.markerLatency),
            }),
            dropped: s.dropped - start.dropped,
            freezes: s.freezes - start.freezes,
            freezeSeconds: s.freezeSeconds - start.freezeSeconds,
            loss: s.lost - start.lost,
            jitterMs: s.jitterMs,
            receivedMbps: (8 * (s.bytes - start.bytes)) / secs / 1e6,
          };
        });
        if (coturn) {
          report.coturnRejoin = [];
          const links = [...byId.entries()];
          for (const [index, viewer] of current.entries()) {
            const [id, previous] = links[index];
            await viewer.js('bench.resetPeer()');
            const reconnect = await connect(viewer, id, previous.description);
            const received = await viewer.js('bench.stats(0)');
            assert.deepEqual(received.ice, ['relay', 'relay']);
            assert(received.decoded > 0);
            const freshCredentials = byId.get(id).turnUsername !== previous.turnUsername;
            if (seconds >= 60) assert(freshCredentials, 'Expected renewed TURN credentials.');
            report.coturnRejoin.push({ firstFrameMs: reconnect.firstFrameMs, freshCredentials });
          }
        }
        if (network) {
          report.networkPhases = [];
          let qualityRecovery;
          if (recovery || sharedUpload) {
            const baseline = report.viewers.map(({ receivedMbps, presentedFps }) => ({
              receivedMbps,
              presentedFps,
            }));
            const measure = (first, last) =>
              last.map((end, index) => {
                const start = first[index];
                const elapsed = (end.time - start.time) / 1000;
                return {
                  fps: (end.presented - start.presented) / elapsed,
                  decodedFps: (end.decoded - start.decoded) / elapsed,
                  receivedFps: (end.received - start.received) / elapsed,
                  mbps: (8 * (end.bytes - start.bytes)) / elapsed / 1e6,
                  loss: end.lost - start.lost,
                  freezes: end.freezes - start.freezes,
                  freezeSeconds: end.freezeSeconds - start.freezeSeconds,
                  jitterBufferMs:
                    ((end.jitterBufferSeconds - start.jitterBufferSeconds) * 1000) /
                    (end.jitterBufferFrames - start.jitterBufferFrames),
                  width: end.width,
                  height: end.height,
                };
              });
            const shapedCount = isolation ? 1 : current.length;
            const cap = sharedUpload ? 6000000 : 2000000;
            const impairmentCpu = cpuTimes();
            const beforeCap = await snapshot();
            const relayStart = network.inspect();
            const voiceBefore = await voice?.sample();
            network.conditions({
              bitrate: cap,
              lossEvery: 30,
              delayMs: 20,
              jitterMs: 8,
              sharedUpload,
            });
            await delay(8000);
            const midway = await snapshot();
            await delay(8000);
            const capped = await snapshot();
            const relayEnd = network.inspect();
            const voiceCapped = await voice?.sample();
            const afterImpairmentCpu = cpuTimes();
            const constrained = measure(beforeCap, capped);
            const capSeconds = (capped[0].time - beforeCap[0].time) / 1000;
            const restore = (bitrate) =>
              network.conditions({ bitrate, lossEvery: 0, delayMs: 0, jitterMs: 0, sharedUpload });
            restore(gradualRecovery ? cap * 2 : 0);
            const clearedAt = performance.now();
            const samples = [];
            let start = capped;
            let consecutive = 0;
            let recoverySeconds;
            for (let step = 1; step <= 10; step++) {
              await delay(Math.max(0, clearedAt + step * 3000 - performance.now()));
              const end = await snapshot();
              const viewers = measure(start, end);
              const seconds = (performance.now() - clearedAt) / 1000;
              samples.push({ seconds, viewers });
              if (gradualRecovery && step === 1) restore(cap * 4);
              if (gradualRecovery && step === 2) restore(0);
              const recovered = viewers
                .slice(0, shapedCount)
                .every(
                  (viewer, index) =>
                    viewer.mbps >= 0.9 * baseline[index].receivedMbps &&
                    viewer.fps >= 0.9 * baseline[index].presentedFps &&
                    end[index].width === 1920 &&
                    end[index].height === 1080 &&
                    end[index].pairId &&
                    end[index].pairId === capped[index].pairId,
                );
              consecutive = recovered ? consecutive + 1 : 0;
              if (consecutive === 2) {
                recoverySeconds = seconds;
                break;
              }
              start = end;
            }
            qualityRecovery = {
              cap,
              gradualRecovery,
              hostCpuPercent:
                100 *
                (1 -
                  (afterImpairmentCpu[0] - impairmentCpu[0]) /
                    (afterImpairmentCpu[1] - impairmentCpu[1])),
              baseline,
              constrained,
              settled: measure(midway, capped),
              relayOfferedMbps:
                (8 * (relayEnd.mediaBytes - relayStart.mediaBytes)) / capSeconds / 1e6,
              relayMbps:
                (8 * (relayEnd.forwardedBytes - relayStart.forwardedBytes)) / capSeconds / 1e6,
              relayQueueMs: relayEnd.phaseMaxQueueMs,
              relayQueueDrops: relayEnd.queueDroppedPackets - relayStart.queueDroppedPackets,
              samples,
              recoverySeconds: recoverySeconds ?? null,
              passed: recoverySeconds !== undefined,
            };
            report.qualityRecovery = qualityRecovery;
            if (voice) {
              const after = await voice.sample();
              const delta = (first, last) => ({
                packets: last.packets - first.packets,
                lost: last.lost - first.lost,
                concealedSamples: last.concealed - first.concealed,
                receivedSamples: last.samples - first.samples,
                jitterMs: last.jitterMs,
                averageBufferMs:
                  ((last.jitterDelay - first.jitterDelay) * 1000) /
                  (last.jitterSamples - first.jitterSamples),
              });
              report.voice = {
                constrained: delta(voiceBefore, voiceCapped),
                recovery: delta(voiceCapped, after),
                publisherOfferedMbps:
                  (8 *
                    (relayEnd.mediaBytes -
                      relayStart.mediaBytes +
                      relayEnd.voice.mediaBytes -
                      relayStart.voice.mediaBytes)) /
                  capSeconds /
                  1e6,
                publisherForwardedMbps:
                  (8 *
                    (relayEnd.forwardedBytes -
                      relayStart.forwardedBytes +
                      relayEnd.voice.forwardedBytes -
                      relayStart.voice.forwardedBytes)) /
                  capSeconds /
                  1e6,
                relayVoiceQueueDrops:
                  relayEnd.voice.queueDroppedPackets - relayStart.voice.queueDroppedPackets,
              };
              assert.ok(report.voice.constrained.packets > 0 && report.voice.recovery.packets > 0);
              assert.ok(relayEnd.voice.forwardedBytes > relayStart.voice.forwardedBytes);
            }
            assert(
              constrained.slice(0, shapedCount).every((viewer) => viewer.fps > 0),
              'Constrained viewers did not present video.',
            );
            if (isolation)
              assert(
                constrained[1].fps >= 50 && constrained[1].mbps >= 0.9 * baseline[1].receivedMbps,
                'The direct viewer lost quality during the other viewer’s impairment.',
              );
          }
          for (const phase of [
            { name: 'constrained', bitrate: 2000000, lossEvery: 30, delayMs: 20, jitterMs: 8 },
            { name: 'interrupted', bitrate: 0, lossEvery: 1, delayMs: 0, jitterMs: 0 },
            { name: 'recovered', bitrate: 0, lossEvery: 0, delayMs: 0, jitterMs: 0 },
          ]) {
            network.conditions(phase);
            const [first, healthyStart] = await snapshot();
            const start = network.inspect();
            await delay(phase.name === 'interrupted' ? 4000 : 10000);
            const [last, healthyEnd] = await snapshot();
            const finish = network.inspect();
            const elapsed = (last.time - first.time) / 1000;
            const metrics = {
              phase,
              presentedFps: (last.presented - first.presented) / elapsed,
              receivedMbps: (8 * (last.bytes - first.bytes)) / elapsed / 1000000,
              droppedDatagrams: finish.droppedPackets - start.droppedPackets,
              receiverLost: last.lost - first.lost,
              receivedRetransmissions: last.retransmitted - first.retransmitted,
              freezes: last.freezes - first.freezes,
              ice: last.ice,
            };
            if (isolation && healthyStart && healthyEnd) {
              const seconds = (healthyEnd.time - healthyStart.time) / 1000;
              metrics.healthyFps = (healthyEnd.presented - healthyStart.presented) / seconds;
              metrics.healthyMbps = (8 * (healthyEnd.bytes - healthyStart.bytes)) / seconds / 1e6;
              assert(
                metrics.healthyFps >= 50 && metrics.healthyMbps >= 8,
                'The healthy peer slowed down while the other peer was constrained.',
              );
            }
            report.networkPhases.push(metrics);
            assert.deepEqual(last.ice, ['relay', 'relay']);
            if (phase.lossEvery) {
              assert(metrics.droppedDatagrams > 0);
              if (phase.lossEvery === 1) assert(metrics.presentedFps < 2);
            } else {
              assert(metrics.presentedFps > 0 && metrics.receivedMbps > 0);
            }
          }
          const [id, original] = byId.entries().next().value;
          const [viewer] = current;
          const releasedBefore = network.inspect().releasedAllocations;
          localRelay.setOffline(true);
          const before = await viewer.js('bench.stats(0)');
          await delay(500);
          const drained = await viewer.js('bench.stats(0)');
          await delay(5500);
          const after = await viewer.js('bench.stats(0)');
          assert(
            after.presented - drained.presented <= 3,
            'Decoded video continued after the receiver buffer drained during a relay outage.',
          );
          assert(localRelay.inspect().blocked > 0);
          localRelay.setOffline(false);
          await viewer.js('bench.resetPeer()');
          const restart = await connect(viewer, id, original.description);
          const restarted = await viewer.js('bench.stats(0)');
          assert.deepEqual(restarted.ice, ['relay', 'relay']);
          const beforeLeave = network.inspect().releasedAllocations;
          await native.closeViewer(id);
          const releaseDeadline = performance.now() + 1000;
          while (
            network.inspect().releasedAllocations === beforeLeave &&
            performance.now() < releaseDeadline
          )
            await delay(25);
          assert(
            network.inspect().releasedAllocations > beforeLeave,
            'Native close did not release its relay allocation.',
          );
          byId.delete(id);
          await viewer.js('bench.resetPeer()');
          const rejoined = await connect(viewer, crypto.randomUUID());
          const rejoinStats = await viewer.js('bench.stats(0)');
          assert.deepEqual(rejoinStats.ice, ['relay', 'relay']);
          report.relayRecovery = {
            outageMs: after.time - before.time,
            outagePresentedFrames: after.presented - before.presented,
            lateOutageFrames: after.presented - drained.presented,
            restartFirstFrameMs: restart.firstFrameMs,
            rejoinFirstFrameMs: rejoined.firstFrameMs,
            selectedPair: rejoinStats.ice,
            releasedAllocations: network.inspect().releasedAllocations - releasedBefore,
          };
          await native.stop();
          await Promise.all(current.map((browser) => browser.js('bench.resetPeer()')));
          for (let attempt = 0; attempt < 20 && network.inspect().allocations; attempt++)
            await delay(50);
          report.relayRecovery.allocatedAfterStop = network.inspect().allocations;
          assert.equal(
            report.relayRecovery.allocatedAfterStop,
            0,
            'Stopping left a relay allocation.',
          );
          assert(
            !qualityRecovery || qualityRecovery.passed,
            'Video bitrate and cadence did not regain 90% of baseline in two consecutive windows within 30 seconds on the same ICE pair.',
          );
        }
        if (expectUnpadded) {
          for (const viewer of report.viewers) {
            assert.equal(viewer.height, 1080);
            assert.ok(viewer.presentedFps >= 55, 'The simple animation must play near 60 fps.');
            assert.ok(
              viewer.receivedMbps > 0 && viewer.receivedMbps < bitrate / 2e6,
              'The simple animation should use less than half the configured bitrate ceiling.',
            );
          }
        }
        if (presents) {
          const result = await presents;
          if (result.error) throw result.error;
          report.gamePresents = result.data;
        }
        if (windowLifecycle) {
          await ownedSource.close();
          await native.expectSourceEnd();
          report.windowLifecycle.sourceEnd = true;
        }
      } catch (error) {
        report.failure = error?.message || String(error);
        process.exitCode = 1;
      } finally {
        sampling = false;
        try {
          await gpuTask;
          report.gpuSamples = gpuSamples;
          await native?.stop();
          game?.stop();
          await Promise.allSettled(current.map((browser) => browser.js('window.bench?.stop()')));
          await Promise.allSettled(iceTasks);
          if (network) report.network = { ...network.inspect(), localRelay: localRelay?.inspect() };
        } finally {
          await Promise.all([localRelay?.close(), network?.close(), voice?.close()]);
        }
        await persist();
        console.log(JSON.stringify(report));
      }
    }
    if (liveGame) {
      if (gameCapture)
        assert(
          !existsSync(path.join(bundle, 'bin/win-capture')),
          'Game Capture wrote into the OBS bundle.',
        );
      const game = await launchFreedoom(profile);
      try {
        if (game.presentMon) await game.until(12000);
        sourceAlone = await game.measure(seconds);
        await persist();
      } finally {
        game.stop();
      }
    }
  } finally {
    await ownedSource?.close();
    tlsRelay?.close();
    for (const viewer of viewers) await viewer.close();
    server.closeAllConnections();
    server.close();
    console.log('Benchmark report ' + output);
  }
}

if (process.versions.electron) {
  assert(
    profile &&
      path.dirname(profile) === fixtureRoot &&
      path.basename(profile).startsWith('obs-benchmark-'),
  );
  void run().then(
    async () => (await import('electron')).app.exit(process.exitCode ?? 0),
    async (error) => {
      console.error(error);
      (await import('electron')).app.exit(1);
    },
  );
} else await launchFixture();
