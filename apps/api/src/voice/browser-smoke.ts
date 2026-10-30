import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from '../auth/service.js';
import { createApp } from '../app.js';
import { voiceConfig } from './config.js';
import { launch, setup, type Browser } from './browser-harness.js';
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
const browsers: Browser[] = [];
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
  await setup(a, first.token, origin);
  await setup(b, second.token, origin);
  await a.js(`window.soundEvents=[];window.nativeSoundPlay=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=async function(){await window.nativeSoundPlay.call(this);if(this.dataset.appSound)window.soundEvents.push({kind:this.dataset.appSound,at:Date.now()})};document.querySelector('.sound-settings').open=true`);
  await a.click('Enable sounds');
  assert.equal(
    await a.js('window.soundEvents.length'),
    0,
    'Enabling mid-call must not replay the roster',
  );
  await b.js('document.querySelector(\'button[aria-label="Leave voice"]\').click()');
  await a.wait('window.soundEvents.some(e=>e.kind==="leave")');
  await a.wait('Date.now()-window.soundEvents.at(-1).at>=300');
  await b.js(
    `(()=>{const s=document.querySelector('select[aria-label="Join voice channel"]');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await a.wait('window.soundEvents.length===2');
  assert.deepEqual(await a.js('window.soundEvents.map(e=>e.kind)'), ['leave', 'join']);
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
  const cuesBeforeReconnect = await a.js('window.soundEvents.length');
  const lease = server.voice!.leases.get(owner.id)!;
  lease.close?.();
  await a.wait('window.__voiceOpens>' + opened);
  await a.wait("document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected'");
  await a.wait("document.querySelectorAll('.voice-members li').length===2");
  assert.equal(
    await a.js('window.soundEvents.length'),
    cuesBeforeReconnect,
    'Reconnect must not replay join cues',
  );
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
    'opt-in mid-call produces no historical cues',
    'real peer leave/rejoin plays distinct sound cues',
    'signaling reconnect does not replay membership sounds',
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
