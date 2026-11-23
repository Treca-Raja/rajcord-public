import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkWindowsAudio } from './obs-audio-service.mjs';
import { percentile, renderedAudioTiming } from './obs-av-timing.mjs';
import {
  AudioPermissionUnconfirmed,
  audioConsoleDiagnostic,
  confirmAudioPermissions,
} from './windows-audio-preflight.mjs';
import { ObsScreen, obsIce, obsRuntime } from '../apps/desktop/dist/obs-screen.js';
import { createScreenNetworkFixture } from '../apps/api/dist/screen/network-fixture.js';
import { startSharedVoiceFixture } from '../apps/api/dist/screen/shared-voice-fixture.js';
import { launch } from '../apps/api/dist/voice/browser-harness.js';
import { screenRelayServers } from '../apps/api/dist/screen/relay.js';
import { parseScreenDescription, parseScreenIce } from '../packages/shared/dist/index.js';
import { bindLocalRelay } from './screen-loopback-relay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = process.env.RAJCORD_SCREEN_BENCH_BUNDLE;
const runtime = bundle
  ? {
      available: true,
      root: path.resolve(bundle),
      executable: path.resolve(bundle, 'bin/rajcord-obs.exe'),
    }
  : obsRuntime(false);
const system = process.argv.includes('--system');
const outputClock = !process.argv.includes('--render-clock');
const debug = process.env.RAJCORD_OBS_AV_DEBUG === '1';
const freshAudio = process.argv.includes('--assert-fresh-audio');
const renderedAudio = process.argv.includes('--rendered-audio');
const rejoin = process.argv.includes('--rejoin');
const matchedDisplay = system || process.argv.includes('--matched-display');
const layered = process.argv.includes('--layered');
const twoViewers = process.argv.includes('--two-viewers');
const viewerCount = process.argv.includes('--three-viewers') ? 3 : twoViewers ? 2 : 1;
const startupCycles = Number(
  process.argv.find((arg) => arg.startsWith('--startup-cycles='))?.slice(17) ?? 0,
);
// A 440 Hz harmonic can otherwise look like leakage from the excluded 880 Hz source.
const otherToneHz = layered || startupCycles ? 1247 : 880;
const sampleScope = process.argv.includes('--sample-scope');
const silentDecoy = process.argv.includes('--silent-decoy');
const outage = process.argv.includes('--relay-outage');
const productionIce = process.argv.includes('--production-ice');
const transport = process.argv.find((arg) => arg.startsWith('--coturn='))?.slice(9);
assert(transport === undefined || ['udp', 'tcp', 'tls'].includes(transport));
const sharedVoicePort = Number(
  process.argv.find((arg) => arg.startsWith('--shared-voice-port='))?.slice(20) ?? 0,
);
assert(
  sharedVoicePort === 0 ||
    (Number.isInteger(sharedVoicePort) && sharedVoicePort >= 1024 && sharedVoicePort <= 65535),
);
const fixtureRelayOnly = Boolean((transport && !productionIce) || sharedVoicePort);
let network, localRelay, voice;
function fixtureServers(mode) {
  if (sharedVoicePort) {
    const [server] = localRelay.configuration.iceServers;
    return [{ ...server, urls: [server.urls] }];
  }
  if (!transport) return [];
  const secret = process.env.SCREEN_COTURN_SECRET;
  assert(secret && /^[a-f0-9]{64}$/.test(secret), 'An isolated coturn fixture is required.');
  const [, server] = screenRelayServers(
    { screenCoturn: { host: 'localhost', secret } },
    mode === 'viewer' ? 'fixture-viewer' : 'fixture-publisher',
    Date.now(),
  );
  const url =
    mode === 'publisher' && transport === 'tls'
      ? server.urls[2]
      : server.urls[transport === 'tcp' ? 1 : 0].replace('localhost', '127.0.0.1');
  return [{ ...server, urls: [url] }];
}
const seconds = Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.slice(10) ?? 16);
assert(Number.isInteger(seconds) && seconds >= 16 && seconds <= 540);
assert(Number.isInteger(startupCycles) && startupCycles >= 0 && startupCycles <= 40);
assert(!startupCycles || (viewerCount === 1 && !rejoin && !renderedAudio && !transport));
assert(!(sampleScope || silentDecoy) || startupCycles, 'Scope diagnostics require startup cycles.');
assert(
  viewerCount === 1 || (!renderedAudio && !rejoin && !outage),
  'Use one viewer for output and rejoin checks.',
);
assert(!outage || transport, 'The outage check requires owned coturn.');
assert(
  !sharedVoicePort ||
    (!transport && !system && viewerCount === 1 && !startupCycles && !rejoin && !outage),
  'Shared-upload A/V needs one application viewer and the owned loopback relay.',
);
assert.equal(process.platform, 'win32', 'OBS audio qualification requires Windows.');
assert(runtime.available, runtime.reason);
runtime.executable = await realpath(runtime.executable);
const base = path.join(root, '.local');
const observerExecutable =
  renderedAudio &&
  (await realpath(
    process.env.RAJCORD_OBS_AUDIO_OBSERVER ??
      path.join(root, 'apps/desktop/native/obs/dist/rajcord-obs-playout.exe'),
  ));
const electron = await realpath(
  createRequire(new URL('../apps/desktop/package.json', import.meta.url))('electron'),
);
const helperSha256 = createHash('sha256')
  .update(await readFile(runtime.executable))
  .digest('hex');
const audioExecutables = [
  `OBS process loopback: ${runtime.executable} (SHA-256 ${helperSha256})`,
  `Electron source and viewer: ${electron}`,
  ...(observerExecutable ? [`Viewer process-loopback observer: ${observerExecutable}`] : []),
].join('\n');
if (process.argv.includes('--list-audio-executables')) {
  console.log(audioExecutables);
  process.exit(0);
}
await mkdir(base, { recursive: true });
const profile = await mkdtemp(path.join(base, 'application-audio-smoke-'));
const owned = [];
let browser, sender, playout;
const additional = [];
let renewal;
let runError;
let runReport;
let audioServiceRecord;
const viewerPage = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<title>Rajcord synthetic A/V receiver</title><main>Selected application audio and video</main>',
  );
});
async function tone(mode) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SCREEN_COTURN_SECRET;
  const child = spawn(
    electron,
    [
      path.join(root, 'scripts/application-audio-smoke.mjs'),
      '--audio-profile=' + profile,
      '--mode=' + mode,
      '--animate-source',
      '--duration=' + Math.min(600, startupCycles ? 90 + startupCycles * 14 : seconds + 105),
      ...(outputClock ? ['--output-clock'] : []),
      ...(matchedDisplay ? ['--fixture-display'] : []),
      ...(layered ? ['--layered'] : []),
      ...(otherToneHz === 1247 ? ['--nonharmonic-tone'] : []),
      ...(mode === 'other' && silentDecoy ? ['--silent-decoy'] : []),
    ],
    { env, windowsHide: false, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exit = once(child, 'exit');
  owned.push({ child, exit });
  const output = createInterface({ input: child.stdout });
  const deadline = setTimeout(() => output.close(), 20000);
  try {
    for await (const line of output) {
      if (line.startsWith('tone-ready:')) return JSON.parse(line.slice('tone-ready:'.length));
    }
  } finally {
    clearTimeout(deadline);
    output.close();
  }
  throw new Error('Owned tone failed to start.');
}

async function measureSharedUpload(stats, viewer, startMeasurement) {
  const sample = async () => ({
    at: performance.now(),
    screen: await stats(viewer),
    voice: await voice.sample(),
    relay: network.inspect(),
  });
  const phase = async (name, duration, conditions) => {
    const before = await sample();
    network.conditions({ ...conditions, sharedUpload: true });
    await startMeasurement(viewer, duration);
    await delay(duration * 1000);
    const after = await sample();
    const markers = await viewer.js('window.measurement');
    const delta = (stream, field) => after[stream][field] - before[stream][field];
    const mediaBits = (flow) => flow.mediaBytes * 8;
    const deltaRate = (select) =>
      ((select(after) - select(before)) * 1000) / (after.at - before.at);
    const row = {
      phase: name,
      durationMs: after.at - before.at,
      videoBps: deltaRate((point) => point.screen.videoBytes * 8),
      screenAudioBps: deltaRate((point) => point.screen.audioBytes * 8),
      aggregateOfferedBps: deltaRate(
        (point) => mediaBits(point.relay) + mediaBits(point.relay.voice),
      ),
      queueMs: after.relay.phaseMaxQueueMs,
      screenAudioPackets: delta('screen', 'audioPacketsReceived'),
      screenAudioLost: delta('screen', 'audioPacketsLost'),
      screenConcealed: delta('screen', 'concealedAudioSamples'),
      screenSamples: delta('screen', 'totalAudioSamples'),
      soundMarkers: markers.soundEdges,
      maxScreenAudioGapMs: markers.longestSoundMarkerGapMs,
      presentedFps: markers.presentedFrames / duration,
      voicePackets: delta('voice', 'packets'),
      voiceLost: delta('voice', 'lost'),
      voiceConcealed: delta('voice', 'concealed'),
      voiceSamples: delta('voice', 'samples'),
      voiceJitterMs: after.voice.jitterMs,
      voiceJitterBufferMs: (1000 * delta('voice', 'jitterDelay')) / delta('voice', 'jitterSamples'),
    };
    console.log(JSON.stringify({ sharedUploadAudio: row }));
    return row;
  };
  const clear = { bitrate: 0, lossEvery: 0, delayMs: 0, jitterMs: 0 };
  const baseline = await phase('baseline', 8, clear);
  const constrained = await phase('constrained', 20, {
    bitrate: 850000,
    lossEvery: 31,
    delayMs: 20,
    jitterMs: 8,
  });
  const recovery = await phase('recovery', 18, clear);
  assert(constrained.queueMs > 0, 'The shared upload did not queue during the imposed cap.');
  for (const row of [baseline, constrained, recovery]) {
    assert(
      row.voicePackets > 0 && row.voiceSamples > row.voiceConcealed,
      'LiveKit voice lost playable audio.',
    );
    assert(
      row.screenAudioPackets > 0 && row.soundMarkers > 1 && row.maxScreenAudioGapMs < 2400,
      'Screen audio lost the authorized tone during the shared-upload test.',
    );
  }
  return [baseline, constrained, recovery];
}

async function monitorViewerAudio(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  // Sample only the audio rendered by the owned viewer process tree.
  const child = spawn(observerExecutable, [String(pid)], {
    cwd: path.dirname(observerExecutable),
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: path.join(process.env.SystemRoot, 'System32'),
      TEMP: process.env.TEMP,
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await once(child, 'spawn');
  let pending = Buffer.alloc(0);
  let previous;
  const edges = [];
  // Each 5 ms block contains nine periods of the fixture's 1800 Hz marker.
  const coefficients = Array.from({ length: 240 }, (_, i) => {
    const phase = (2 * Math.PI * 1800 * i) / 48000;
    return [Math.cos(phase), Math.sin(phase)];
  });
  child.stdout.on('error', (error) => {
    if (debug) console.error(error.code);
  });
  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const wall = performance.timeOrigin + performance.now();
    while (pending.length >= 480) {
      let real = 0,
        imaginary = 0;
      for (let i = 0; i < 240; i++) {
        const sample = pending.readInt16LE(i * 2);
        real += sample * coefficients[i][0];
        imaginary += sample * coefficients[i][1];
      }
      pending = pending.subarray(480);
      const audible = Math.hypot(real, imaginary) / (240 * 16384) > 0.001;
      if (previous === false && audible) edges.push(wall - (1000 * pending.length) / 96000);
      previous = audible;
    }
  });
  return {
    edges,
    stop() {
      child.stdin.destroy();
      child.stdout.destroy();
    },
  };
}

async function calibrateOutput(viewer, monitor) {
  const expected = await viewer.js(`(async () => {
    const clock = window.probeOutput;
    const signal = clock.createOscillator(), volume = clock.createGain();
    signal.frequency.value = 1800;
    volume.gain.value = 0;
    signal.connect(volume).connect(clock.destination);
    const start = clock.currentTime + 0.25;
    signal.start();
    for (let i = 0; i < 20; i++) volume.gain.setValueAtTime(i % 2 ? 0 : 0.012, start + i * 0.2);
    const anchors = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 350));
      const observed = clock.getOutputTimestamp();
      if (observed.performanceTime > 0)
        anchors.push(observed.performanceTime - observed.contextTime * 1000);
    }
    signal.stop();
    signal.disconnect();
    volume.disconnect();
    const reference = anchors.sort((a,b)=>a-b)[Math.floor(anchors.length/2)];
    return Array.from({length:10}, (_, i) => performance.timeOrigin + reference + (start + i * 0.4) * 1000);
  })()`);
  const offsets = expected
    .flatMap((time) => {
      const captured = monitor.edges.reduce(
        (nearest, edge) => (Math.abs(edge - time) < Math.abs(nearest - time) ? edge : nearest),
        Infinity,
      );
      return Math.abs(captured - time) < 120 ? [captured - time] : [];
    })
    .sort((a, b) => a - b);
  assert(
    offsets.length >= 6,
    `The viewer output clock matched only ${offsets.length}/${expected.length} calibration tones.`,
  );
  monitor.edges.length = 0;
  return {
    matched: offsets.length,
    medianMs: offsets[Math.floor(offsets.length / 2)],
    spreadMs: offsets.at(-1) - offsets[0],
  };
}

try {
  if (sharedVoicePort) {
    network = await createScreenNetworkFixture();
    localRelay = await bindLocalRelay(network.configuration);
    voice = await startSharedVoiceFixture(
      sharedVoicePort,
      await network.voiceUpload(sharedVoicePort),
    );
  }
  obsIce(fixtureServers('publisher'));
  console.log(JSON.stringify({ audioPreflight: 'awaiting-ready', system, helperSha256 }));
  await confirmAudioPermissions(
    `The ${system ? 'full-display' : 'application'} audio warm-up will open audio devices for the executables below. Stay at the desktop and compare any new prompt with the exact paths.\n${audioExecutables}`,
    { warmup: true, ...(sharedVoicePort && { signal: AbortSignal.timeout(90000) }) },
  );
  audioServiceRecord = await checkWindowsAudio();
  console.log(JSON.stringify({ audioPreflight: 'warmup', system, helperSha256 }));
  // The unpackaged Rajcord viewer restricts auth-smoke profiles to this loopback origin.
  const listening = once(viewerPage, 'listening');
  viewerPage.listen(3002, '127.0.0.1');
  await listening;
  const [target, other] = await Promise.all([tone('target'), tone('other')]);
  const handle = target.id.split(':')[1];
  const { stdout } = await promisify(execFile)(
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      path.join(root, 'apps/desktop/src/window-audio-process.ps1'),
      '-WindowIds',
      handle,
      '-ExcludedProcess',
      String(other.pid),
    ],
    { windowsHide: true },
  );
  const [identity] = JSON.parse(stdout);
  assert.equal(identity.processId, target.pid);
  assert.ok(Number.isFinite(target.markerStartMs));
  const launchViewer = () =>
    launch({
      fakeMicrophone: false,
      rajcordDesktop: true,
      loopbackIce: Boolean(transport || sharedVoicePort),
    });
  browser = await launchViewer();
  await browser.wait(
    "document.title==='Rajcord synthetic A/V receiver' && window.tricordDesktop?.platform==='win32' && document.visibilityState==='visible'",
  );
  if (renderedAudio) {
    // Render a distinct quiet tone while the process-scoped observer opens the
    // endpoint. A viewer with no active output can leave the capture waiting.
    await browser.js(`(async () => {
      window.probeOutput = new AudioContext({sampleRate: 48000});
      await probeOutput.resume();
      const tone = probeOutput.createOscillator(), gain = probeOutput.createGain();
      tone.frequency.value = 137;
      gain.gain.value = 0.003;
      tone.connect(gain).connect(probeOutput.destination);
      tone.start();
    })()`);
  }
  let tag = randomUUID();
  let linkId = randomUUID();
  const candidates = new Map();
  let fatal;
  let firstAudioRtpAgeMs;
  let pcmSamples = 0;
  let workingSetBytes;
  let nativeDiagnostics = '';
  const openSender = () =>
    new ObsScreen(
      runtime,
      tag,
      (event) => {
        if ('ice' in event) candidates.get(event.linkId)?.push(event);
      },
      (reason) => {
        fatal = reason;
      },
      undefined,
      (chunk) => {
        nativeDiagnostics += chunk;
        const end = nativeDiagnostics.lastIndexOf('\n') + 1;
        const complete = nativeDiagnostics.slice(0, end);
        for (const line of complete.split('\n')) {
          const row = line.trimEnd();
          if (audioConsoleDiagnostic(row, debug)) process.stderr.write(row + '\n');
        }
        pcmSamples += [...complete.matchAll(/^timing audio\/pcm /gm)].length;
        const sample = /^timing audio\/rtp .* age=(-?\d+(?:\.\d+)?)\r?$/m.exec(complete);
        if (sample && firstAudioRtpAgeMs === undefined) firstAudioRtpAgeMs = Number(sample[1]);
        const usage = /^native_working_set_bytes=(\d+)\r?$/m.exec(complete);
        if (usage) workingSetBytes = Number(usage[1]);
        nativeDiagnostics = nativeDiagnostics.slice(end);
      },
      fixtureRelayOnly,
    );
  const grants = new Map();
  const observe = (id, answerHash) => {
    grants.set(id, answerHash);
    sender.observe(
      {
        iceServers: fixtureServers('publisher'),
        viewers: [...grants].map(([id, hash]) => ({ id, remainingMs: 45000, answerHash: hash })),
      },
      Date.now(),
    );
  };
  const command = (op, args = {}, id = linkId) => sender.command({ tag, linkId: id, op, ...args });
  const startSource = async () => {
    sender = openSender();
    if (system) {
      assert(target.monitor?.length === 4 && target.monitor.every(Number.isInteger));
      // The receiving player is on this machine in the render fixture. Exclude
      // its whole process tree just as the product excludes its local player.
      await sender.start([
        'monitor',
        ...target.monitor.map(String),
        'system',
        String(renderedAudio ? browser.child.pid : other.pid),
      ]);
    } else {
      await sender.start([
        'window',
        handle,
        'app',
        String(identity.processId),
        identity.started,
        String(other.pid),
      ]);
    }
  };
  async function connect(viewer = browser, id = linkId, op = 'open') {
    const started = performance.now();
    const peerCandidates = [];
    candidates.set(id, peerCandidates);
    observe(id, null);
    const sdp = await command(
      op,
      {
        deadline: Date.now() + 44000,
        video: { width: 854, height: 480, fps: 60, bitrate: 2000000 },
      },
      id,
    );
    const description = parseScreenDescription(sdp, 'offer');
    assert.deepEqual(description.kinds, ['m=video', 'm=audio']);
    const payloadTypes = sdp
      .split('\r\n')
      .filter((line) => line.startsWith('m='))
      .flatMap((line) => line.split(' ').slice(3));
    assert.equal(
      new Set(payloadTypes).size,
      payloadTypes.length,
      'BUNDLE requires distinct payload types for Opus, H.264 and RTX.',
    );
    await command('local', { sdp }, id);
    const answer = await viewer.js(`(async()=>{
    window.pc = new RTCPeerConnection({
      iceServers:${JSON.stringify(fixtureServers('viewer'))},
      iceTransportPolicy:${fixtureRelayOnly ? "'relay'" : "'all'"},bundlePolicy:'max-bundle'
    });
    window.streamGroups = {};
    const video = document.createElement('video');video.autoplay=true;video.muted=${!renderedAudio};
    video.volume=${renderedAudio ? 0.28 : 1};document.body.append(video);
    const presentation = new MediaStream();video.srcObject=presentation;
    window.context = new AudioContext({sampleRate:48000});
    window.analyser = context.createAnalyser();analyser.fftSize=8192;
    await context.resume();
    window.scopeLevels = () => {
      const bins=new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      const level = hz => {const i=Math.round(hz*analyser.fftSize/context.sampleRate);return Math.max(-200,...bins.slice(i-2,i+3));};
      return {targetDb:level(440),otherDb:level(${otherToneHz})};
    };
    pc.ontrack=({track, streams})=>{
      streamGroups[track.kind] = streams.map(stream => stream.id);
      presentation.addTrack(track);
      if(track.kind==='audio' && window.context) {
        window.audioSource=context.createMediaStreamSource(new MediaStream([track]));
        audioSource.connect(analyser);
      }
    };
    await pc.setRemoteDescription({type:'offer',sdp:${JSON.stringify(sdp)}});
    for(const tx of pc.getTransceivers()) tx.direction='recvonly';
    await pc.setLocalDescription(await pc.createAnswer());
    if(pc.iceGatheringState!=='complete') await new Promise(resolve=>pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve();});
    return pc.localDescription.sdp;
  })()`);
    parseScreenDescription(answer, 'answer');
    if (debug)
      for (const [kind, description] of [
        ['offer', sdp],
        ['answer', answer],
      ])
        console.log(
          kind,
          description
            .split('\r\n')
            .filter((line) => /^(m=|a=(rtpmap|mid|sendonly|recvonly|fmtp|msid|ssrc):?)/.test(line)),
        );
    const answerHash = createHash('sha256').update(answer).digest('hex');
    observe(id, answerHash);
    await command('answer', { sdp: answer }, id);
    const candidateReady = () =>
      transport || sharedVoicePort
        ? peerCandidates.some((candidate) => / typ relay\b/.test(candidate.ice))
        : peerCandidates.length > 0;
    for (let i = 0; i < 250 && !candidateReady(); i++) await delay(20);
    assert.ok(candidateReady(), 'The native ICE agent did not gather the expected candidate.');
    for (const candidate of peerCandidates) {
      const dto = parseScreenIce({
        candidate: candidate.ice,
        sdpMLineIndex: candidate.index,
        sdpMid: description.mids[candidate.index],
        usernameFragment: description.ufrags[candidate.index],
      });
      await viewer.js('pc.addIceCandidate(' + JSON.stringify(dto) + ')');
    }
    await viewer.wait("document.querySelector('video').srcObject.getAudioTracks().length === 1");
    await viewer.wait(`pc.getStats().then(report => {
      const inbound = [...report.values()].filter(item => item.type === 'inbound-rtp');
      return inbound.some(item => item.kind === 'audio' && item.bytesReceived > 4000)
        && inbound.some(item => item.kind === 'video' && item.framesDecoded > 5);
    })`);
    return { answerHash, ufrag: description.ufrags[0], mediaReadyMs: performance.now() - started };
  }
  function assertScopeLevels(levels) {
    assert(levels.targetDb > -90, 'Expected the source tone in the decoded audio.');
    if (system && renderedAudio) {
      assert(levels.otherDb > -90, 'Expected the second source tone in full-display audio.');
    } else {
      assert(levels.targetDb - levels.otherDb > 30, 'Expected exclusion of the other process.');
    }
  }
  if (startupCycles) {
    for (let cycle = 1; cycle <= startupCycles; cycle++) {
      const started = performance.now();
      tag = randomUUID();
      linkId = randomUUID();
      grants.clear();
      candidates.clear();
      fatal = undefined;
      firstAudioRtpAgeMs = undefined;
      pcmSamples = 0;
      workingSetBytes = undefined;
      nativeDiagnostics = '';
      let startup;
      let error;
      let levels;
      let report;
      const scopeSamples = [];
      try {
        await startSource();
        await confirmAudioPermissions(
          `The helper opened audio for startup cycle ${cycle}/${startupCycles}. Clear any matching prompt before continuing.`,
        );
        startup = await connect();
        assert(pcmSamples > 0, 'Expected timestamped WASAPI PCM before Opus encoding.');
        assert(
          Number.isFinite(firstAudioRtpAgeMs) && firstAudioRtpAgeMs < 60,
          'First Opus RTP packet must be fresh.',
        );
        levels = await browser.js('window.scopeLevels()');
        if (sampleScope) {
          for (let i = 0; i < 6; i++) {
            await delay(180);
            scopeSamples.push(await browser.js('window.scopeLevels()'));
          }
        }
        assertScopeLevels(levels);
      } catch (failure) {
        if (failure instanceof AudioPermissionUnconfirmed) throw failure;
        error = fatal ?? failure.message.split('\n')[0];
      } finally {
        const stopped = performance.now();
        sender?.stop();
        const exit = await sender?.stopped;
        await browser.js(`(async () => {
          window.pc?.close();
          document.querySelector('video')?.remove();
          if (window.context?.state !== 'closed') await window.context?.close();
        })()`);
        report = {
          cycle,
          system,
          helperSha256,
          mediaReadyMs: startup && stopped - started,
          firstAudioRtpAgeMs,
          pcmSamples,
          levels,
          otherToneHz,
          silentDecoy,
          scopeSamples: sampleScope ? scopeSamples : undefined,
          workingSetBytes,
          cleanupMs: performance.now() - stopped,
          exit,
          error,
        };
      }
      await checkWindowsAudio(audioServiceRecord);
      if (error?.includes('0x88890010')) {
        throw new Error('OBS audio fixture environment failed: ' + error);
      }
      await confirmAudioPermissions(
        `Startup cycle ${cycle}/${startupCycles} has stopped${error ? ': ' + error : '.'} Confirm audio permissions stayed granted throughout this cycle.`,
      );
      console.log(JSON.stringify({ ...report, audioPermissionsConfirmed: true }));
      if (error) throw new Error('OBS audio startup check failed: ' + error);
    }
  } else {
    const warmup = await Promise.allSettled([
      startSource(),
      renderedAudio &&
        monitorViewerAudio(browser.child.pid).then((monitor) => {
          playout = monitor;
        }),
    ]);
    const blocked = warmup.find(({ status }) => status === 'rejected');
    await checkWindowsAudio(audioServiceRecord);
    console.log(JSON.stringify({ audioPreflight: 'permission-check', pcmSamples }));
    await confirmAudioPermissions(
      blocked
        ? 'The audio warm-up stopped before every endpoint opened. Clear any matching prompt now so a separate run can reuse the same executable permissions.'
        : (pcmSamples ? 'The OBS helper is already receiving PCM. ' : '') +
            'Windows has attempted audio access. If Kaspersky shows no prompt and audio access is already granted, you can confirm now.',
    );
    if (blocked)
      throw new AudioPermissionUnconfirmed(
        'audio warm-up did not complete. ' + blocked.reason.message.split('\n')[0],
      );
    const outputCalibration = playout && (await calibrateOutput(browser, playout));
    const initial = await connect();
    assert(pcmSamples > 0, 'Expected timestamped WASAPI PCM before Opus encoding.');
    const initialLevels = await browser.js('window.scopeLevels()');
    assertScopeLevels(initialLevels);
    for (let i = 1; i < viewerCount; i++) {
      const viewer = await launchViewer();
      const id = randomUUID();
      additional.push({ viewer, id });
      await connect(viewer, id);
    }
    renewal = setInterval(() => {
      observe(linkId, initial.answerHash);
      for (const id of grants.keys())
        void sender
          .command({ tag, linkId: id, op: 'lease', deadline: Date.now() + 44000 })
          .catch((reason) => {
            fatal = reason;
          });
    }, 10000);
    const startMeasurement = (viewer, duration = seconds) =>
      viewer.js(`(() => {
    window.measurement = (async () => {
    const picture = document.querySelector('video'), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const pixels = canvas.getContext('2d', {willReadFrequently:true});
    const marker = window.context?.createAnalyser();
    if (marker) {
      marker.fftSize = 1024; marker.smoothingTimeConstant = 0;
      audioSource.connect(marker);
    }
    const bins = marker && new Float32Array(marker.frequencyBinCount);
    const soundEdges=[], visualEdges=[];
    let lastLight, lastSound;
    const started=performance.now();
    const end=started+${duration * 1000};
    let firstPicture, firstSound;
    let frame, firstPresented, lastPresented;
    const pictureTimes = [];
    const samplePicture = (_now, metadata) => {
        const display = metadata.expectedDisplayTime;
        firstPicture ??= display - started;
        firstPresented ??= metadata.presentedFrames;
        lastPresented = metadata.presentedFrames;
        pictureTimes.push(display);
        pixels.drawImage(picture,picture.videoWidth/2,picture.videoHeight/2,1,1,0,0,1,1);
        const light=pixels.getImageData(0,0,1,1).data[0]>130;
        if(lastLight===false && light) visualEdges.push(display);
        lastLight=light;
        frame = picture.requestVideoFrameCallback(samplePicture);
    };
    frame = picture.requestVideoFrameCallback(samplePicture);
    while (performance.now()<end) {
      await new Promise(resolve=>setTimeout(resolve,8));
      const now=performance.now();
      if (marker) {
        marker.getFloatFrequencyData(bins);
        const bin=Math.round(1800*marker.fftSize/context.sampleRate);
        const sound=Math.max(bins[bin-1],bins[bin],bins[bin+1])>-53;
        if (sound) firstSound ??= now - started;
        if(lastSound===false && sound) soundEdges.push(now);
        lastSound=sound;
      }
    }
    picture.cancelVideoFrameCallback(frame);
    if (marker) audioSource.disconnect(marker);
    const markerStart=${target.markerStartMs};
    const delayFromSchedule = time => {
      const elapsed = performance.timeOrigin + time - markerStart;
      return elapsed - Math.round(elapsed / 800) * 800;
    };
    return {
      startWall:performance.timeOrigin + started, firstPictureMs:firstPicture, firstSoundMs:firstSound,
      presentedFrames: firstPresented === undefined ? 0 : lastPresented - firstPresented + 1,
      pictureGapsMs: pictureTimes.slice(1).map((time, i) => time - pictureTimes[i]),
      visualEdges:visualEdges.length, soundEdges:soundEdges.length,
      longestVisualMarkerGapMs: Math.max(0, ...visualEdges.slice(1).map((time, i) => time-visualEdges[i])),
      longestSoundMarkerGapMs: Math.max(0, ...soundEdges.slice(1).map((time, i) => time-soundEdges[i])),
      visualWallMs: visualEdges.map(time => performance.timeOrigin + time),
      matches:visualEdges.flatMap(videoTime => {
        const audioTime = soundEdges.reduce((best, t) =>
          Math.abs(t-videoTime)<Math.abs(best-videoTime) ? t : best, Infinity);
        return Math.abs(audioTime-videoTime)<400 ? [{
          seconds:(videoTime-started)/1000, audioMinusVideoMs:audioTime-videoTime,
          scheduledToVideoMs:delayFromSchedule(videoTime), scheduledToAudioMs:delayFromSchedule(audioTime),
        }] : [];
      }),
    }; })();
  })()`);
    const measurements = [browser, ...additional.map(({ viewer }) => viewer)];
    await checkWindowsAudio(audioServiceRecord);
    console.log(JSON.stringify({ audioPreflight: 'media-ready', pcmSamples, initialLevels }));
    const pcmBeforeMeasurement = pcmSamples;
    await Promise.all(measurements.map((viewer) => startMeasurement(viewer)));
    await delay(seconds * 1000);
    const timing = await browser.js('window.measurement');
    const stats = (viewer) =>
      viewer.js(`(async()=>{
    const stats = [...(await pc.getStats()).values()];
    const audio = stats.find(i=>i.type==='inbound-rtp'&&i.kind==='audio');
    const video = stats.find(i=>i.type==='inbound-rtp'&&i.kind==='video');
    const pair = stats.find(i=>i.id===stats.find(j=>j.type==='transport')?.selectedCandidatePairId);
    return {...window.scopeLevels?.(),audioBytes:audio.bytesReceived,audioPacketsReceived:audio.packetsReceived,videoFrames:video.framesDecoded,
      videoBytes:video.bytesReceived,videoPacketsLost:video.packetsLost,
      receivedRetransmissions:video.retransmittedPacketsReceived,
      ice:[stats.find(i=>i.id===pair?.localCandidateId)?.candidateType,stats.find(i=>i.id===pair?.remoteCandidateId)?.candidateType],
      audioPacketsLost:audio.packetsLost,concealedAudioSamples:audio.concealedSamples,totalAudioSamples:audio.totalSamplesReceived,
      averageAudioJitterBufferMs:1000*audio.jitterBufferDelay/audio.jitterBufferEmittedCount,
      averageVideoJitterBufferMs:1000*video.jitterBufferDelay/video.jitterBufferEmittedCount,
      sharedStreamGroup:streamGroups.audio?.some(id=>streamGroups.video?.includes(id)),
      estimatedAudioPlayout:audio.estimatedPlayoutTimestamp,
      estimatedVideoPlayout:video.estimatedPlayoutTimestamp,
      audioCodec:stats.find(i=>i.id===audio.codecId).mimeType,videoCodec:stats.find(i=>i.id===video.codecId).mimeType};
  })()`);
    const result = await stats(browser);
    const relayAllocations = transport
      ? [
          ...(await (await fetch('http://127.0.0.1:19641/metrics')).text()).matchAll(
            /^turn_total_allocations\{[^\r\n]*\}\s+([0-9]+)\s*$/gm,
          ),
        ].reduce((sum, match) => sum + Number(match[1]), 0)
      : undefined;
    const stable = timing.matches.filter((edge) => edge.seconds >= 6);
    const offsets = stable.map((edge) => edge.audioMinusVideoMs);
    const median = percentile(offsets, 0.5);
    const summary = offsets.length && {
      medianMs: median,
      startupMarkerMs: timing.matches[0]?.audioMinusVideoMs,
      p95AbsoluteMs: percentile(offsets.map(Math.abs), 0.95),
      maxAbsoluteMs: Math.max(...offsets.map(Math.abs)),
      p95DeviationFromMedianMs: percentile(
        offsets.map((offset) => Math.abs(offset - median)),
        0.95,
      ),
      lastWindowMinusFirstWindowMs:
        percentile(offsets.slice(-12), 0.5) - percentile(offsets.slice(0, 12), 0.5),
    };
    const rendered =
      playout &&
      renderedAudioTiming(timing.visualWallMs, playout.edges, outputCalibration, timing.startWall);
    const presentation = ({ pictureGapsMs, presentedFrames, ...markers }, duration) => ({
      ...markers,
      presentedFps: presentedFrames / duration,
      p95PresentationGapMs: percentile(pictureGapsMs, 0.95),
    });
    runReport = {
      helperSha256,
      transport,
      productionIce,
      system,
      matchedDisplay,
      layered,
      outputClock,
      seconds,
      mediaReadyMs: initial.mediaReadyMs,
      relayAllocations,
      firstAudioRtpAgeMs,
      pcmSamples: pcmSamples - pcmBeforeMeasurement,
      ...result,
      summary,
      renderedAudio: rendered,
      timing: presentation(timing, seconds),
    };
    for (const { viewer } of additional) {
      const observed = await stats(viewer);
      const secondTiming = await viewer.js('window.measurement');
      assert(observed.videoFrames > 0 && observed.audioBytes > 0);
      assert(observed.targetDb > -90 && observed.targetDb - observed.otherDb > 30);
      if (transport) assert.deepEqual(observed.ice, ['relay', 'relay']);
      assert(secondTiming.matches.length >= Math.floor((seconds / 0.8) * 0.75));
      const offsets = secondTiming.matches
        .filter((edge) => edge.seconds >= 6)
        .map((edge) => edge.audioMinusVideoMs);
      console.log(
        JSON.stringify({
          secondViewer: observed,
          matched: secondTiming.matches.length,
          medianMs: percentile(offsets, 0.5),
          p95AbsoluteMs: percentile(offsets.map(Math.abs), 0.95),
          presentedFps: secondTiming.presentedFrames / seconds,
          p95PresentationGapMs: percentile(secondTiming.pictureGapsMs, 0.95),
        }),
      );
    }
    if (transport && viewerCount === 3 && process.env.RAJCORD_COTURN_TEST_CONTAINER) {
      const { stdout } = await promisify(execFile)(
        'docker',
        [
          'stats',
          '--no-stream',
          '--format',
          '{{.CPUPerc}} {{.MemUsage}} {{.NetIO}}',
          process.env.RAJCORD_COTURN_TEST_CONTAINER,
        ],
        { windowsHide: true },
      );
      console.log(JSON.stringify({ coturnUnderThreeViewers: stdout.trim() }));
    }
    assert.ok(!fatal && result.videoFrames > 0 && result.audioBytes > 0);
    assert(pcmSamples > pcmBeforeMeasurement, 'No timestamped PCM during the measurement.');
    assertScopeLevels(result);
    if (transport && !productionIce) {
      assert.deepEqual(result.ice, ['relay', 'relay']);
      assert(
        relayAllocations >= viewerCount * 2,
        'Expected both peers to allocate for each viewer.',
      );
    }
    if (productionIce)
      assert(
        result.ice.every((kind) => ['host', 'srflx', 'prflx'].includes(kind)),
        'Normal ICE must prefer an available direct path after TLS relay gathering.',
      );
    if (rendered)
      assert(
        rendered.steadyMarkers >= Math.floor(((seconds - 6) / 0.8) * 0.75) &&
          rendered.matched >= rendered.visualMarkers - 12,
        'Expected rendered audio markers.',
      );
    assert.equal(result.audioCodec.toLowerCase(), 'audio/opus');
    assert.equal(result.videoCodec.toLowerCase(), 'video/h264');
    if (sharedVoicePort) {
      assert.deepEqual(result.ice, ['relay', 'relay']);
      runReport.sharedUploadAudio = await measureSharedUpload(stats, browser, startMeasurement);
    }
    if (freshAudio)
      assert(
        firstAudioRtpAgeMs < 60,
        'First audio RTP packet contained stale pre-negotiation audio.',
      );
    if (!renderedAudio) {
      assert.ok(
        timing.matches.length >= Math.floor((seconds / 0.8) * 0.75),
        'Expected to match at least 75% of the flash and tone markers.',
      );
      if (transport && seconds >= 120)
        assert(
          timing.matches.at(-1)?.seconds >= seconds - 3,
          'Relay lost media before the final measurement window.',
        );
    }
    clearInterval(renewal);
    const resetViewer = () =>
      browser.js(`(async () => {
    pc.close();
    document.querySelector('video').remove();
    await window.context?.close();
  })()`);
    if (outage) {
      const container = process.env.RAJCORD_COTURN_TEST_CONTAINER;
      assert(container && /^[a-f0-9]{64}$/.test(container));
      const docker = (...args) => promisify(execFile)('docker', args, { windowsHide: true });
      const labels = await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}',
        container,
      );
      assert.equal(labels.stdout.trim(), 'rajcord-screen-turn-fixture');
      await docker('pause', container);
      let before, interrupted;
      try {
        // Drop queued playback before sampling the already-paused relay.
        await delay(300);
        before = await stats(browser);
        await delay(4000);
        interrupted = await stats(browser);
      } finally {
        await docker('unpause', container);
      }
      assert(interrupted.videoFrames - before.videoFrames < 5);
      assert(interrupted.audioBytes === before.audioBytes);
      await resetViewer();
      const restart = await connect(browser, linkId, 'restart');
      assert.notEqual(restart.ufrag, initial.ufrag);
      const restarted = await stats(browser);
      assert.deepEqual(restarted.ice, ['relay', 'relay']);
      assert(
        restarted.targetDb > -90 && restarted.targetDb - restarted.otherDb > 30,
        'Expected scoped audio after ICE restart.',
      );
      console.log(
        JSON.stringify({
          relayRestartMs: restart.mediaReadyMs,
          outageDecodedFrames: interrupted.videoFrames - before.videoFrames,
        }),
      );
    }
    if (transport && rejoin) {
      sender.observe({ iceServers: [], viewers: [] }, Date.now());
      await assert.rejects(command('lease', { deadline: Date.now() + 10000 }), /ended/);
      await delay(300);
      const revoked = await stats(browser);
      await delay(650);
      const stopped = await stats(browser);
      assert.equal(stopped.audioBytes, revoked.audioBytes);
      assert.equal(stopped.videoBytes, revoked.videoBytes);
      console.log(JSON.stringify({ relayAuthorizationRevoked: true }));
    }
    await command('close');
    grants.delete(linkId);
    candidates.delete(linkId);
    for (const { id } of additional) {
      await command('close', {}, id);
      grants.delete(id);
    }
    if (rejoin) {
      await resetViewer();
      linkId = randomUUID();
      firstAudioRtpAgeMs = undefined;
      await connect();
      if (freshAudio) assert(firstAudioRtpAgeMs < 60, 'Rejoined viewer received stale Opus.');
      let rejoinTiming;
      if (playout) {
        playout.edges.length = 0;
        await startMeasurement(browser, 5);
        await delay(5200);
        const watch = await browser.js('window.measurement');
        rejoinTiming = renderedAudioTiming(
          watch.visualWallMs,
          playout.edges,
          outputCalibration,
          watch.startWall,
        );
        assert(rejoinTiming.matched >= 4, 'Expected rendered A/V after rejoin.');
      } else {
        const rejoined = await stats(browser);
        assert(
          rejoined.targetDb > -90 && rejoined.targetDb - rejoined.otherDb > 30,
          'Expected scoped audio after rejoin.',
        );
        if (transport && !productionIce) assert.deepEqual(rejoined.ice, ['relay', 'relay']);
      }
      console.log(JSON.stringify({ rejoin: true, firstAudioRtpAgeMs, rejoinTiming }));
      await command('close');
    }
    if (system && renderedAudio) {
      await browser.close();
      browser = undefined;
    } else {
      const targetProcess = owned.find(
        ({ child }) => child.pid === (system ? other.pid : target.pid),
      );
      assert(targetProcess);
      targetProcess.child.kill();
      await targetProcess.exit;
    }
    for (let i = 0; i < 100 && !fatal; i++) await delay(25);
    assert(fatal, 'The native helper must stop when an authorized capture process exits.');
  }
} catch (error) {
  runError = error;
} finally {
  clearInterval(renewal);
  playout?.stop();
  sender?.stop();
  await sender?.stopped;
  for (const { child } of owned) child.kill();
  await Promise.allSettled(owned.map(({ exit }) => exit));
  await browser?.close();
  await Promise.allSettled(additional.map(({ viewer }) => viewer.close()));
  if (network) {
    const cleanup = await Promise.allSettled([
      voice?.close(),
      localRelay?.close(),
      network.close(),
    ]);
    runError ??= cleanup.find(({ status }) => status === 'rejected')?.reason;
  }
  if (viewerPage.listening) {
    viewerPage.closeAllConnections();
    await new Promise((resolve) => viewerPage.close(resolve));
  }
  assert.equal(path.dirname(profile), base);
  assert(path.basename(profile).startsWith('application-audio-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
if (!audioServiceRecord || runError instanceof AudioPermissionUnconfirmed) throw runError;
await checkWindowsAudio(audioServiceRecord);
if (!startupCycles) {
  const error = runError?.message.split('\n')[0];
  let audioPermissionsConfirmed = false;
  console.log(JSON.stringify({ audioPreflight: 'final-confirmation' }));
  try {
    await confirmAudioPermissions(
      (error ? `The test stopped: ${error}\n` : 'Media measurements finished.\n') +
        'Confirm audio permissions stayed granted throughout the run, including startup and calibration.',
    );
    audioPermissionsConfirmed = true;
  } finally {
    if (runReport || error)
      console.log(
        JSON.stringify({
          ...(runReport ?? { system, helperSha256 }),
          audioPermissionsConfirmed,
          passed: audioPermissionsConfirmed && !error,
          ...(error && { error }),
        }),
      );
  }
}
if (runError) throw runError;
