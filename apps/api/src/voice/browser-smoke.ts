import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from '../auth/service.js';
import { createApp } from '../app.js';
import { voiceConfig } from './config.js';
const origin = 'http://127.0.0.1:3004',
  config = voiceConfig();
if (!config) throw new Error('Run voice:setup and voice:up.');
const fixture = await testDatabase(),
  auth = new AuthService(fixture.database.pool);
const appOptions = {
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  rateLimits: false,
  voiceConfig: { ...config, prefix: 'tricord-smoke-' + randomUUID() + '-' },
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
};
let server = createApp(appOptions);
const artifacts = fileURLToPath(new URL('../../../../artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
type Browser = Awaited<ReturnType<typeof launch>>;
const browsers: Browser[] = [];
async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), 'tricord-voice-browser-'));
  const wav = Buffer.alloc(44 + 48000 * 2 * 4);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 4; i++)
    wav.writeInt16LE(
      Math.round(5000 * Math.sin((i * 2 * Math.PI * 440) / 48000) * (Math.floor(i / 12000) % 2)),
      44 + i * 2,
    );
  const audio = path.join(profile, 'tone.wav');
  await writeFile(audio, wav);
  const child = spawn(
    process.env.TRICORD_BROWSER_PATH ||
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + audio,
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  let port = '';
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try {
      port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.match(port, /^\d+$/);
  const pages = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const ws = new WebSocket(pages.find((p) => p.type === 'page')!.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data));
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message));
    else request.resolve(data.result);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP failed')), { once: true });
  });
  const call = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }, 20000);
      pending.set(id, {
        resolve: (value) => resolve(value as Record<string, unknown>),
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expression: string) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error('Browser JS failed: ' + JSON.stringify(result.exceptionDetails));
    return (result.result as { value: unknown }).value;
  };
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await delay(100);
    }
    console.error(
      await js(
        'JSON.stringify((window.__peers??[]).map(p=>({state:p.connectionState,candidates:p.__candidates})))',
      ),
    );
    throw new Error(
      'Voice browser timeout: ' + expression + '; UI: ' + (await js('document.body.innerText')),
    );
  };
  const click = async (label: string) =>
    js(
      "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===" +
        JSON.stringify(label) +
        ");if(!b)throw Error('Missing button');b.click()})()",
    );
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "window.__voiceOpens=0;const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);if(String(args[0]).includes('/media/'))this.addEventListener('open',()=>window.__voiceOpens++)}};window.__peers=[];const Original=window.RTCPeerConnection;window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.__peers.push(this);this.__candidates=[];const add=this.addIceCandidate.bind(this);this.addIceCandidate=(candidate)=>{this.__candidates.push(candidate);return add(candidate)}}};window.__captureCount=0;const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{window.__captureCount++;return capture(...args)};",
  });
  return {
    child,
    ws,
    call,
    js,
    wait,
    click,
    close: async () => {
      try {
        await call('Browser.close');
      } catch {
        child.kill();
      }
      ws.close();
      for (const entry of pending.values()) clearTimeout(entry.timer);
    },
  };
}
async function setup(browser: Browser, token: string) {
  await browser.call('Network.setCookie', {
    name: 'tricord_session',
    value: token,
    url: origin,
    httpOnly: true,
    sameSite: 'Strict',
  });
  await browser.call('Emulation.setDeviceMetricsOverride', {
    width: 1360,
    height: 980,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.call('Page.navigate', { url: origin });
  await browser.wait("!!document.querySelector('.voice-settings-toggle')");
  await browser.js("document.querySelector('.voice-settings-toggle').click()");
  await browser.click('Find audio devices');
  await browser.wait(
    'document.querySelector(\'select[aria-label="Voice microphone"]\').options.length>1',
  );
  for (const label of ['Voice microphone', 'Voice speakers']) {
    await browser.js(
      "(()=>{const s=document.querySelector('select[aria-label=" +
        JSON.stringify(label) +
        "]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
  }
  await browser.wait(
    '!document.querySelector(\'select[aria-label="Join voice channel"]\').disabled',
  );
  await browser.js(
    "(()=>{const s=document.querySelector('select[aria-label=\"Join voice channel\"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  await browser.wait(
    "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'",
  );
}
const received =
  "Promise.all(window.__peers.map(p=>p.getStats())).then(reports=>reports.flatMap(r=>[...r.values()]).filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').reduce((sum,s)=>sum+(s.bytesReceived||0),0))";
try {
  await server.app.listen({ host: '127.0.0.1', port: 3004 });
  const password = randomUUID() + '-Voice';
  const owner = await auth.bootstrap('voice_owner', 'Voice owner', password);
  const member = await auth.register({
    username: 'voice_friend',
    displayName: 'Voice friend',
    password,
  });
  const first = await auth.login({ username: owner.username, password, remember: true }, undefined);
  await auth.changeStatus(first.token, member.id, 'approve');
  const second = await auth.login(
    { username: member.username, password, remember: true },
    undefined,
  );
  const a = await launch();
  browsers.push(a);
  const b = await launch();
  browsers.push(b);
  await setup(a, first.token);
  await setup(b, second.token);
  for (const browser of [a, b]) {
    await browser.wait("document.querySelectorAll('.voice-members li').length===2");
    await browser.js('document.querySelector(\'button[aria-label="Unmute microphone"]\').click()');
  }
  await a.wait('(' + received + ').then(bytes=>bytes>1000)');
  await b.wait('(' + received + ').then(bytes=>bytes>1000)');
  assert.ok(
    (await server.voice!.media.listParticipants([...server.voice!.leases.values()][0]!.room)).every(
      (p) => p.tracks.every((t) => t.source === 2),
    ),
  );
  await a.js('document.querySelector(\'button[aria-label="Mute microphone"]\').click()');
  await b.wait(
    "document.querySelector('.voice-members').innerText.includes('Voice owner · muted')",
  );
  await a.js("document.querySelector('button[aria-label=Deafen]').click()");
  await a.wait("[...document.querySelectorAll('audio[data-voice-audio]')].every(e=>e.paused)");
  await a.js("document.querySelector('button[aria-label=Deafen]').click()");
  const opened = await a.js('window.__voiceOpens');
  const lease = server.voice!.leases.get(owner.id)!;
  lease.close?.();
  await a.wait('window.__voiceOpens>' + opened);
  await a.wait("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'");
  await a.wait("document.querySelectorAll('.voice-members li').length===2");
  assert.equal(
    await a.js(
      "document.querySelector('button[aria-label=\"Unmute microphone\"]')?.getAttribute('aria-pressed')",
    ),
    'true',
  );

  const oldReservation = server.voice!.leases.get(owner.id)!.id;
  await server.app.close();
  server = createApp(appOptions);
  await server.app.listen({ host: '127.0.0.1', port: 3004 });
  for (let attempt = 0; attempt < 200 && server.voice!.leases.size !== 2; attempt++)
    await delay(100);
  assert.equal(server.voice!.leases.size, 2, 'Both clients must recover after API restart');
  assert.notEqual(server.voice!.leases.get(owner.id)!.id, oldReservation);
  await a.wait("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'");
  await b.wait("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'");
  await b.wait("document.querySelectorAll('.voice-members li').length===2");
  await b.js(
    "(()=>{const slider=document.querySelector('.voice-members input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.25');slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await b.wait(
    "[...document.querySelectorAll('audio[data-voice-audio]')].some(e=>e.volume===0.25)",
  );

  // Simulate a missing exact input. No default capture is allowed.
  const captures = await a.js('window.__captureCount');
  await a.js(
    "window.__enumerate=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=> (await window.__enumerate()).filter(d=>d.kind!=='audioinput');navigator.mediaDevices.dispatchEvent(new Event('devicechange'))",
  );
  await a.wait("document.body.innerText.includes('microphone is missing')");
  await delay(300);
  assert.equal(await a.js('window.__captureCount'), captures);
  await a.js('navigator.mediaDevices.enumerateDevices=window.__enumerate');

  await a.js(
    "navigator.mediaDevices.enumerateDevices=async()=> (await window.__enumerate()).filter(d=>d.kind!=='audiooutput');navigator.mediaDevices.dispatchEvent(new Event('devicechange'))",
  );
  await a.wait("document.body.innerText.includes('speakers are missing')");
  assert.equal(
    await a.js(
      "[...document.querySelectorAll('audio[data-voice-audio]')].every(e=>e.paused&&e.muted)",
    ),
    true,
  );
  await a.js('navigator.mediaDevices.enumerateDevices=window.__enumerate');

  const shot = await b.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    path.join(artifacts, 'voice-browser.png'),
    Buffer.from(String(shot.data), 'base64'),
  );
  const previousLease = server.voice!.leases.get(owner.id)!;
  previousLease.expires = 0;
  await server.voice!.reconcile();
  await a.wait(
    "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='reconnecting'",
  );
  await a.wait("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'");
  assert.notEqual(server.voice!.leases.get(owner.id)?.id, previousLease.id);
  const stale = server.voice!.leases.get(member.id)!.id;
  await auth.changeStatus(first.token, member.id, 'suspend');
  await server.voice!.reconcile();
  await b.wait("document.querySelectorAll('audio[data-voice-audio]').length===0");
  await assert.rejects(server.voice!.authorize(second.token, stale));
  await a.js('document.querySelector(\'button[aria-label="Leave voice"]\').click()');
  await a.wait("!document.querySelector('[data-voice-status]')");
  await delay(500);
  assert.equal(server.voice!.leases.size, 0);
  const checks = [
    'two isolated approved sessions',
    'explicit input/output selection',
    'both join muted',
    'bidirectional received audio bytes',
    'microphone-only media grants',
    'remote mute state',
    'deafen stops playback',
    'signaling reconnect',
    'mute preserved on recovery',
    'missing input never selects fallback',
    'suspension removes media',
    'revoked credential rejected',
    'manual leave stops recovery',
    'expired reservation recovers with live authentication',
    'both clients recover after API restart',
    'participant volume changes playback',
    'missing output mutes playback without fallback',
  ];
  await writeFile(
    path.join(artifacts, 'voice-browser.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(
    'PASS: ' +
      checks.length +
      ' real browser voice checks with synthetic audio through local LiveKit.',
  );
} finally {
  for (const browser of browsers) await browser.close();
  await server.app.close();
  for (const room of await server.voice!.media.listRooms())
    if (room.name.startsWith(server.voice!.prefix)) await server.voice!.media.deleteRoom(room.name);
  await fixture.cleanup();
}
