import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { AuthService } from '../../api/src/auth/service';
import { createApp } from '../../api/src/app';
import { testDatabase } from '../../api/src/db/test-database';
import { checkVoiceTestServices } from '../../api/src/voice/test-services';
import { launch, setup, type Browser } from '../../api/src/voice/browser-harness';

const syntheticSource = `
window.__screenTest={calls:0,options:[],tracks:[],peers:[]};
const NativePeer=window.RTCPeerConnection;
window.RTCPeerConnection=class extends NativePeer{constructor(config){super(config);window.__screenTest.peers.push(this)}};
navigator.mediaDevices.getDisplayMedia=async(options)=>{
 const f=window.__screenTest;f.calls++;f.options.push(options);
 const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
 const context=canvas.getContext('2d');let frame=0;
 const draw=()=>{context.fillStyle='#1c2630';context.fillRect(0,0,1920,1080);context.fillStyle='#a6ce8a';context.fillRect((frame++*12)%1800,100,120,800);context.fillStyle='white';context.font='50px sans-serif';context.fillText('OWNED SYNTHETIC SCREEN '+frame,60,80)};
 draw();const drawing=setInterval(draw,16),stream=canvas.captureStream(60),video=stream.getVideoTracks()[0];
 const settings=video.getSettings.bind(video),stop=video.stop.bind(video);
 video.getSettings=()=>({...settings(),displaySurface:'browser',width:1920,height:1080,frameRate:60});
 video.stop=()=>{clearInterval(drawing);stop()};f.tracks.push(video);
 if(options.audio){const audio=new AudioContext(),destination=audio.createMediaStreamDestination(),tone=audio.createOscillator();tone.connect(destination);tone.start();const track=destination.stream.getAudioTracks()[0];stream.addTrack(track);f.tracks.push(track);const end=track.stop.bind(track);track.stop=()=>{tone.stop();void audio.close();end()}}
 return stream;
};`;

it.each(['none', 'tab', 'three'] as const)(
  'shares %s source sound in the actual app with independent quality, renewal, hide/resume and Stop preserving voice',
  async (sound) => {
    const config = await checkVoiceTestServices(),
      database = await testDatabase();
    const origin = 'http://127.0.0.1:3012',
      prefix = 'screen-call-ui-' + randomUUID() + '-';
    const server = createApp({
      databaseUrl: database.url,
      voiceConfig: { ...config, prefix },
      allowedOrigins: [origin],
      rateLimits: false,
      staticRoot: fileURLToPath(new URL('../dist', import.meta.url)),
    });
    const browsers: Browser[] = [];
    try {
      const auth = new AuthService(database.database.pool),
        password = randomUUID() + '-ScreenUI';
      await auth.bootstrap('screen_ui_owner', 'Screen owner', password);
      const publisher = await auth.login(
        { username: 'screen_ui_owner', password, remember: false },
        undefined,
      );
      const member = await auth.register({
        username: 'screen_ui_viewer',
        displayName: 'Screen viewer',
        password,
      });
      await auth.changeStatus(publisher.token, member.id, 'approve');
      const viewer = await auth.login(
        { username: 'screen_ui_viewer', password, remember: false },
        undefined,
      );
      await server.app.listen({ host: '127.0.0.1', port: 3012 });
      for (const account of [publisher, viewer]) {
        const browser = await launch();
        browsers.push(browser);
        await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: syntheticSource });
        await setup(browser, account.token, origin);
        await browser.js("document.querySelector('.screen-launcher > button').click()");
        await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
      }
      if (sound === 'three') {
        for (let i = 2; i <= 3; i++) {
          const account = await auth.register({
            username: 'screen_ui_viewer_' + i,
            displayName: 'Screen viewer ' + i,
            password,
          });
          await auth.changeStatus(publisher.token, account.id, 'approve');
          const login = await auth.login(
            { username: account.username, password, remember: false },
            undefined,
          );
          const browser = await launch();
          browsers.push(browser);
          await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: syntheticSource });
          await setup(browser, login.token, origin);
          await browser.js("document.querySelector('.screen-launcher > button').click()");
          await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
        }
      }
      const [a, b] = browsers as [Browser, Browser];
      const choose = (browser: Browser, label: string, value: string) =>
        browser.js(
          `(()=>{const select=document.querySelector('[aria-label="${label}"]');select.value='${value}';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
        );
      await choose(a, 'Screen resolution', '720');
      await choose(a, 'Screen frame rate', '60');
      await choose(a, 'Screen video bitrate', '4000000');
      if (sound === 'tab') await choose(a, 'Screen source sound', 'tab');
      expect(await a.js('window.__screenTest.calls')).toBe(0);
      await a.click('Prepare source');
      await a.wait("document.querySelector('#screen-panel')?.dataset.prepared==='true'");
      expect(await a.js('window.__screenTest.calls')).toBe(0);
      await a.click('Choose source');
      await a.wait("document.querySelector('#screen-panel')?.dataset.phase==='preview'");
      expect(await a.js('window.__screenTest.options[0].video')).toEqual({
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, max: 60 },
      });
      expect(
        await a.js('document.querySelector(\'[aria-label="Local screen preview"]\').muted'),
      ).toBe(true);
      expect(
        await b.js(
          "[...document.querySelectorAll('.screen-watch button')].some(button=>button.textContent.includes('Screen owner'))",
        ),
      ).toBe(false);
      await a.click('Start sharing');
      await a.wait("document.querySelector('#screen-panel')?.dataset.phase==='sharing'");
      await b.wait(
        "[...document.querySelectorAll('.screen-watch button')].some(button=>button.textContent.includes('Screen owner'))",
      );
      await choose(b, 'Watch resolution', '720');
      await choose(b, 'Watch frame rate', '30');
      await choose(b, 'Watch video bitrate', '2000000');
      await b.js("document.querySelector('.screen-watch input[type=checkbox]').click()");
      await b.js(
        "[...document.querySelectorAll('.screen-watch button')].find(button=>button.textContent.includes('Screen owner')).click()",
      );
      await b.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
      await a.wait("document.querySelector('.screen-status').textContent.includes('1 viewers')");
      const parameters = await a.js(
        `window.__screenTest.peers.flatMap(peer=>peer.getSenders()).filter(sender=>sender.track?.kind==='video').map(sender=>sender.getParameters().encodings[0])`,
      );
      expect(parameters).toEqual([
        expect.objectContaining({ maxBitrate: 2000000, maxFramerate: 30 }),
      ]);
      const routes = await a.js(
        `Promise.all(window.__screenTest.peers.filter(peer=>peer.getSenders().some(sender=>sender.track?.kind==='video')).map(async peer=>{const stats=await peer.getStats();const transport=[...stats.values()].find(stat=>stat.type==='transport'&&stat.selectedCandidatePairId);const pair=stats.get(transport?.selectedCandidatePairId);return pair?[stats.get(pair.localCandidateId)?.candidateType,stats.get(pair.remoteCandidateId)?.candidateType]:[]}))`,
      );
      expect(routes).toEqual([
        [
          expect.stringMatching(/^(host|srflx|prflx)$/),
          expect.stringMatching(/^(host|srflx|prflx)$/),
        ],
      ]);
      if (sound === 'tab') {
        expect(await a.js('window.__screenTest.options[0].audio')).toBe(true);
        expect(
          await a.js("window.__screenTest.tracks.filter(track=>track.kind==='audio').length"),
        ).toBe(1);
        await b.wait(
          "Promise.all(window.__screenTest.peers.filter(peer=>peer.getTransceivers().some(t=>t.receiver.track.kind==='video')).map(peer=>peer.getStats())).then(reports=>reports.some(report=>[...report.values()].some(stat=>stat.type==='inbound-rtp'&&stat.kind==='audio'&&stat.bytesReceived>0)))",
        );
        expect(await b.js("document.querySelector('[data-screen-playback]').muted")).toBe(true);
      }
      await choose(b, 'Watch frame rate', '15');
      await b.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
      await a.wait(
        "window.__screenTest.peers.filter(peer=>peer.connectionState!=='closed').flatMap(peer=>peer.getSenders()).some(sender=>sender.track?.kind==='video'&&sender.getParameters().encodings[0]?.maxFramerate===15)",
      );
      if (sound === 'three') {
        for (const browser of browsers.slice(2)) {
          await browser.wait(
            "[...document.querySelectorAll('.screen-watch button')].some(button=>button.textContent.includes('Screen owner'))",
          );
          await browser.js("document.querySelector('.screen-watch input[type=checkbox]').click()");
          await browser.js(
            "[...document.querySelectorAll('.screen-watch button')].find(button=>button.textContent.includes('Screen owner')).click()",
          );
          await browser.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
        }
        await a.wait("document.querySelector('.screen-status').textContent.includes('3 viewers')");
      }
      const shareId = server.voice!.leases.get(publisher.auth.user.id)!.id;
      // Cross the original 45-second bind/source/link deadline without recapture.
      await new Promise<void>((resolve) => setTimeout(resolve, 47000));
      expect(await a.js("document.querySelector('#screen-panel').dataset.phase")).toBe('sharing');
      expect(await a.js('window.__screenTest.calls')).toBe(1);
      expect(server.voice!.leases.get(publisher.auth.user.id)!.id).toBe(shareId);
      expect(
        await b.js("document.querySelector('[data-screen-playback]').videoWidth"),
      ).toBeGreaterThan(0);
      await b.js(
        "Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))",
      );
      await b.wait("!document.querySelector('[data-screen-playback]')");
      await a.wait(
        `document.querySelector('.screen-status').textContent.includes('${sound === 'three' ? 2 : 0} viewers')`,
      );
      expect(await a.js('window.__screenTest.tracks[0].readyState')).toBe('live');
      await b.js(
        "Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))",
      );
      await b.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
      await a.wait(
        "window.__screenTest.peers.filter(peer=>peer.connectionState!=='closed').flatMap(peer=>peer.getSenders()).some(sender=>sender.track?.kind==='video'&&sender.getParameters().encodings[0]?.maxFramerate===15)",
      );
      const artifacts = fileURLToPath(new URL('../../../artifacts/', import.meta.url));
      await mkdir(artifacts, { recursive: true });
      const screenshot = (await b.call('Page.captureScreenshot')) as { data: string };
      await writeFile(artifacts + '/screen-sharing-ui.png', Buffer.from(screenshot.data, 'base64'));
      await a.js('document.querySelector(\'[aria-label="Stop screen sharing"]\').click()');
      expect(
        await a.js("window.__screenTest.tracks.every(track=>track.readyState==='ended')"),
      ).toBe(true);
      await b.wait("!document.querySelector('[data-screen-playback]')");
      for (const browser of browsers.slice(2))
        await browser.wait("!document.querySelector('[data-screen-playback]')");
      for (const browser of browsers)
        expect(
          await browser.js("document.querySelector('[data-voice-status]')?.dataset.voiceStatus"),
        ).toBe('connected');
    } finally {
      for (const browser of browsers) await browser.close();
      await server.app.close();
      for (const room of await server.voice!.media.listRooms())
        if (room.name.startsWith(prefix)) await server.voice!.media.deleteRoom(room.name);
      await database.cleanup();
    }
  },
  120000,
);
