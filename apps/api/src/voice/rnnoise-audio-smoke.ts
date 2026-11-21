import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser-harness.js';

const rate = 48000;
const duration = 14;
const speech = await readFile(new URL('fixtures/rnnoise-speech.wav', import.meta.url));
const wave = Buffer.alloc(44 + duration * rate * 2);
speech.copy(wave, 0, 0, 44);
wave.writeUInt32LE(wave.length - 8, 4);
wave.writeUInt32LE(rate, 24);
wave.writeUInt32LE(rate * 2, 28);
wave.writeUInt32LE(wave.length - 44, 40);
const pcm = new Int16Array(wave.buffer, wave.byteOffset + 44, rate * duration);
let seed = 41;
for (let i = 0; i < pcm.length; i++) {
  const t = i / rate;
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  const noise = (seed / 0x100000000) * 2 - 1;
  const fan = 700 * Math.sin(t * 2 * Math.PI * 117) + 350 * Math.sin(t * 2 * Math.PI * 234);
  const click = 8000 * noise * Math.exp(-((i % 7109) / 370));
  const speechIndex = Math.floor((i % (rate * 3)) / 6) * 2;
  const voice = speech.readInt16LE(44 + speechIndex);
  if (t >= 2 && t < 4.5) pcm[i] = fan + noise * 220;
  if (t >= 4.5 && t < 7.5) pcm[i] = click;
  if (t >= 7.5 && t < 10.5) pcm[i] = voice * 0.15;
  if (t >= 10.5 && t < 13.5) pcm[i] = voice * 0.7 + fan + click;
}

const dist = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
const assets = await readdir(join(dist, 'assets'));
const binary = assets.find((name) => /^rnnoise-[\w-]+\.wasm$/.test(name));
const worklet = assets.find((name) => /^rnnoise-worklet-[\w-]+\.js$/.test(name));
const html = await readFile(join(dist, 'index.html'), 'utf8');
const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
assert.ok(binary && worklet && policy, 'Build the production web app before running this check.');
const wasmBytes = await readFile(join(dist, 'assets', binary));
const script = await readFile(join(dist, 'assets', worklet));
const notices = await readFile(join(dist, 'rnnoise-licenses.txt'), 'utf8');
assert.ok(notices.includes('Xiph.Org Foundation') && notices.includes('musl libc'));

const server = createServer((request, response) => {
  if (request.url === '/' + binary)
    response.writeHead(200, { 'Content-Type': 'application/wasm' }).end(wasmBytes);
  else if (request.url === '/' + worklet)
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
  else
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': policy })
      .end('<!doctype html><title>RNNoise audio fixture</title>');
});
const fixtureDir = await mkdtemp(join(tmpdir(), 'rajcord-rnnoise-'));
try {
  const fixture = join(fixtureDir, 'mixture.wav');
  await writeFile(fixture, wave);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const modes = [];
  for (const mode of ['off', 'browser', 'rnnoise']) {
    const browser = await launch({ fakeAudioFile: fixture });
    try {
      await browser.call('Browser.grantPermissions', { origin, permissions: ['audioCapture'] });
      await browser.call('Page.navigate', { url: origin });
      await browser.wait('location.origin===' + JSON.stringify(origin));
      const result = (await browser.js(`(async () => {
        const context = new AudioContext({sampleRate:48000});
        const dt = 1024/48000;
        let initMs = 0;
        let node;
        if (${JSON.stringify(mode)} === 'rnnoise') {
          const start = performance.now();
          const [module] = await Promise.all([
            WebAssembly.compileStreaming(fetch(${JSON.stringify('/' + binary)})),
            context.audioWorklet.addModule(${JSON.stringify('/' + worklet)})
          ]);
          node = new AudioWorkletNode(context, 'rajcord-rnnoise', {
            channelCount:1, channelCountMode:'explicit', outputChannelCount:[1], processorOptions:{module}
          });
          initMs = performance.now()-start;
        }
        const stream = await navigator.mediaDevices.getUserMedia({audio:{
          noiseSuppression:${mode === 'browser'}, echoCancellation:false, autoGainControl:false
        }});
        try {
          const track = stream.getAudioTracks()[0];
          const source = context.createMediaStreamSource(stream);
          const recorder = context.createScriptProcessor(1024,1,1);
          const zero = context.createGain(); zero.gain.value=0;
          if (node) source.connect(node).connect(recorder);
          else source.connect(recorder);
          recorder.connect(zero).connect(context.destination);
          await context.resume();
          return await new Promise((resolve, reject) => {
            const starts = [0.7, 2.8, 5.4, 8.1, 11.1];
            const sums = [0,0,0,0,0], counts = [0,0,0,0,0];
            let first, last, gaps=0, callbacks=0;
            node?.addEventListener('processorerror', () => reject(new Error('RNNoise processor failed')));
            recorder.onaudioprocess = event => {
              const t=event.playbackTime;
              first ??= t;
              if (last !== undefined && t-last>dt*1.5) gaps++;
              last=t;
              callbacks++;
              const window = starts.findIndex(start=>t-first>=start && t-first<start+0.8);
              if (window>=0) {
                for (const sample of event.inputBuffer.getChannelData(0)) sums[window]+=sample*sample;
                counts[window]+=1024;
              }
              if (t-first>=12) resolve({
                initMs, gaps, callbacks, rms:sums.map((sum,i)=>Math.sqrt(sum/counts[i])),
                browserSuppression:track.getSettings().noiseSuppression
              });
            };
          });
        } finally {
          stream.getTracks().forEach(track=>track.stop());
          node?.port.close();
          await context.close();
        }
      })()`)) as {
        initMs: number;
        gaps: number;
        callbacks: number;
        rms: number[];
        browserSuppression: boolean;
      };
      assert.equal(result.browserSuppression, mode === 'browser');
      assert.ok(result.callbacks > 500 && result.rms.every(Number.isFinite));
      assert.ok(result.rms[3]! > 0.001 && result.rms[4]! > 0.001, mode + ' lost all speech');
      modes.push({ mode, ...result });
    } finally {
      await browser.close();
    }
  }

  // Run the same WASM ABI over two minutes of simulated microphone time without browser I/O.
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const wasm = instance.exports as {
    memory: WebAssembly.Memory;
    _initialize(): void;
    malloc(size: number): number;
    rnnoise_create(model: number): number;
    rnnoise_process_frame(state: number, output: number, input: number): number;
  };
  wasm._initialize();
  const state = wasm.rnnoise_create(0);
  const addressInWasm = wasm.malloc(480 * 4);
  const frame = new Float32Array(wasm.memory.buffer, addressInWasm, 480);
  const output = new Float32Array(pcm.length);
  for (let i = 0; i < rate * 120; i += frame.length) {
    for (let j = 0; j < frame.length; j++) frame[j] = pcm[(i + j) % pcm.length]!;
    wasm.rnnoise_process_frame(state, addressInWasm, addressInWasm);
    assert.ok(frame.every(Number.isFinite));
    if (i + frame.length < output.length) output.set(frame, i + frame.length);
  }
  const cpu = process.cpuUsage(cpuStart);
  const kernel120s = { wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000 };
  // Align the quiet recorded speech against the output including the worklet's one-frame delay.
  let peak = -1;
  let delaySamples = 0;
  for (let lag = 0; lag <= 2400; lag++) {
    let correlation = 0;
    let energy = 0;
    for (let i = 8 * rate; i < 10 * rate; i += 8) {
      const sample = output[i + lag]!;
      correlation += pcm[i]! * sample;
      energy += sample * sample;
    }
    correlation /= Math.sqrt(energy);
    if (correlation > peak) {
      peak = correlation;
      delaySamples = lag;
    }
  }
  const report = {
    windows: ['silence', 'fan', 'keyboard', 'quietSpeech', 'speechWithNoise'],
    modes,
    delayMs: (delaySamples / rate) * 1000,
    kernel120s,
  };
  const artifacts = fileURLToPath(new URL('../../../../artifacts/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'rnnoise-audio.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  server.close();
  await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
