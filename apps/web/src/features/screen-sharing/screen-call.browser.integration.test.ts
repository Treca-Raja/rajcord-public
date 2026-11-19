import { expect, it, vi } from 'vitest';
import type { ScreenSelectRequest } from '@tricord/shared';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { AuthService } from '../../../../api/src/auth/service';
import { createApp } from '../../../../api/src/app';
import { testDatabase } from '../../../../api/src/db/test-database';
import { checkVoiceTestServices } from '../../../../api/src/voice/test-services';
import { launch, setup, type Browser } from '../../../../api/src/voice/browser-harness';

const syntheticSource = `
window.__screenTest={calls:0,options:[],tracks:[],peers:[]};
const NativePeer=window.RTCPeerConnection;
window.RTCPeerConnection=class extends NativePeer{constructor(config){super(config);window.__screenTest.peers.push(this)}};
navigator.mediaDevices.getDisplayMedia=async(options)=>{
 const f=window.__screenTest;f.calls++;f.options.push(options);
 const canvas=document.createElement('canvas');canvas.width=options.video.width.ideal;canvas.height=options.video.height.ideal;
 const context=canvas.getContext('2d');let frame=0;
 const draw=()=>{context.fillStyle='#1c2630';context.fillRect(0,0,1920,1080);context.fillStyle='#a6ce8a';context.fillRect((frame++*12)%1800,100,120,800);context.fillStyle='white';context.font='50px sans-serif';context.fillText('OWNED SYNTHETIC SCREEN '+frame,60,80)};
 draw();const drawing=setInterval(draw,16),stream=canvas.captureStream(options.video.frameRate.ideal),video=stream.getVideoTracks()[0];
 const settings=video.getSettings.bind(video),stop=video.stop.bind(video);
 video.getSettings=()=>({...settings(),displaySurface:'browser',});
 video.stop=()=>{clearInterval(drawing);stop()};f.tracks.push(video);
 if(options.audio){const audio=new AudioContext(),destination=audio.createMediaStreamDestination(),tone=audio.createOscillator();tone.connect(destination);tone.start();const track=destination.stream.getAudioTracks()[0];stream.addTrack(track);f.tracks.push(track);const end=track.stop.bind(track);track.stop=()=>{tone.stop();void audio.close();end()}}
 return stream;
};`;

for (const sound of ['none', 'tab', 'three', 'nine'] as const) {
  it(
    'shares ' +
      sound +
      ' source sound in the actual app with independent quality, renewal, hide/resume and Stop preserving voice',
    async () => {
      const fanoutCase = sound === 'three' || sound === 'nine';
      const viewerCount = sound === 'nine' ? 9 : 3;
      const captureScript =
        sound === 'none'
          ? syntheticSource.replace("displaySurface:'browser',", '')
          : syntheticSource;
      const config = await checkVoiceTestServices(),
        database = await testDatabase();
      const origin = 'http://127.0.0.1:3012',
        prefix = 'screen-call-ui-' + randomUUID() + '-';
      const server = createApp({
        databaseUrl: database.url,
        voiceConfig: { ...config, prefix },
        allowedOrigins: [origin],
        rateLimits: false,
        staticRoot: fileURLToPath(new URL('../../../dist', import.meta.url)),
      });
      const browsers: Browser[] = [];
      const renewals = new Map<string, number>();
      const commandDiagnostics: { event: string; ms: number; code?: string }[] = [];
      server.io.on('connection', (socket) => {
        socket.use((packet, next) => {
          const event = String(packet[0]),
            ack = packet.at(-1) as unknown;
          if (event.startsWith('screen:') && typeof ack === 'function') {
            const started = Date.now();
            packet[packet.length - 1] = (value: { code?: string }) => {
              commandDiagnostics.push({ event, ms: Date.now() - started, code: value?.code });
              ack(value);
            };
          }
          next();
        });
        socket.onAny((event) => {
          if (event === 'screen:renew') renewals.set(socket.id, (renewals.get(socket.id) ?? 0) + 1);
        });
      });
      let cleanupGate: Promise<void> | undefined, releaseCleanup: (() => void) | undefined;
      let cleanupSeen = false;
      const select = server.screen!.select.bind(server.screen!);
      vi.spyOn(server.screen!, 'select').mockImplementation(async (...args) => {
        if ((args[1] as ScreenSelectRequest).shareId === null && cleanupGate) {
          cleanupSeen = true;
          await cleanupGate;
        }
        return select(...args);
      });
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
          await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: captureScript });
          await setup(browser, account.token, origin);
          await browser.js("document.querySelector('.screen-launcher > button').click()");
          await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
        }
        if (fanoutCase) {
          for (let i = 2; i <= viewerCount; i++) {
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
            await browser.call('Page.addScriptToEvaluateOnNewDocument', {
              source: syntheticSource,
            });
            await setup(browser, login.token, origin);
            await browser.js("document.querySelector('.screen-launcher > button').click()");
            await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
          }
        }
        const voiceBytes = () =>
          Promise.all(
            browsers.map(
              (browser) =>
                browser.js(
                  "Promise.all(window.__peers.map(peer=>peer.getStats())).then(reports=>reports.flatMap(report=>[...report.values()]).filter(stat=>stat.type==='inbound-rtp'&&stat.kind==='audio').reduce((sum,stat)=>sum+(stat.bytesReceived||0),0))",
                ) as Promise<number>,
            ),
          );
        if (sound === 'nine') {
          for (const browser of browsers)
            await browser.js(
              'document.querySelector(\'button[aria-label="Unmute microphone"]\').click()',
            );
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
        if (sound === 'none') {
          await a.js(`(() => {
            const setParameters = RTCRtpSender.prototype.setParameters;
            RTCRtpSender.prototype.setParameters = function (parameters) {
              if (parameters.degradationPreference === 'maintain-framerate-and-resolution')
                throw new TypeError('Unsupported degradation preference');
              return setParameters.call(this, parameters);
            };
          })()`);
          await a.click('Prepare source');
          await a.wait(
            "document.querySelector('.screen-error')?.textContent.includes('Choose Adaptive capture in the browser')",
          );
          expect(await a.js('window.__screenTest.calls')).toBe(0);
          expect(commandDiagnostics.some(({ event }) => event === 'screen:publish')).toBe(false);
          await choose(a, 'Screen capture mode', 'adaptive');
          expect(await a.js('!document.querySelector(\'[aria-label="Screen resolution"]\')')).toBe(
            true,
          );
        }
        expect(await a.js('window.__screenTest.calls')).toBe(0);
        await a.click('Prepare source');
        await a.wait("document.querySelector('#screen-panel')?.dataset.prepared==='true'");
        expect(await a.js('window.__screenTest.calls')).toBe(0);
        await a.click('Choose source');
        await a.wait("document.querySelector('#screen-panel')?.dataset.phase==='preview'");
        expect(await a.js('window.__screenTest.options[0].video')).toEqual({
          width: { ideal: sound === 'none' ? 1920 : 1280 },
          height: { ideal: sound === 'none' ? 1080 : 720 },
          frameRate: { ideal: 60, max: 60 },
        });
        expect(await a.js('window.__screenTest.options[0].audio')).toBe(sound === 'tab');
        expect(
          await a.js('document.querySelector(\'[aria-label="Local screen preview"]\').muted'),
        ).toBe(true);
        expect(
          await b.js(
            "[...document.querySelectorAll('.screen-share-item')].some(item=>item.textContent.includes('Screen owner'))",
          ),
        ).toBe(false);
        await a.click('Start sharing');
        await a.wait("document.querySelector('#screen-panel')?.dataset.phase==='sharing'");
        await b.wait(
          "[...document.querySelectorAll('.screen-share-item')].some(item=>item.textContent.includes('Screen owner'))",
        );
        await choose(b, 'Watch resolution', '720');
        await choose(b, 'Watch frame rate', '30');
        await choose(b, 'Watch video bitrate', '2000000');
        await b.js("document.querySelector('.screen-watch input[type=checkbox]').click()");
        await b.js(
          "[...document.querySelectorAll('.screen-share-item')].find(item=>item.textContent.includes('Screen owner')).querySelector('.screen-share-action').click()",
        );
        await b.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
        if (sound === 'none') {
          const thumbnail =
            "document.querySelector('#screen-participants .screen-stream-thumbnail')";
          const player = "document.querySelector('[data-screen-playback]')";
          await b.wait(thumbnail + '?.videoWidth>0');
          await b.js(
            `void (window.__thumbnailTest={thumbnail:${thumbnail}, player:${player}, stream:${player}.srcObject, time:${player}.currentTime})`,
          );
          await b.js('document.querySelector(\'[aria-label="Hide members"]\').click()');
          await b.wait(
            `!${thumbnail} && window.__thumbnailTest.thumbnail.paused && window.__thumbnailTest.thumbnail.srcObject===null`,
          );
          await b.wait(
            `${player}===window.__thumbnailTest.player && ${player}.srcObject===window.__thumbnailTest.stream && ${player}.currentTime>window.__thumbnailTest.time`,
          );
          await b.js('document.querySelector(\'[aria-label="Show members"]\').click()');
          await b.wait(
            `${thumbnail}?.videoWidth>0 && ${thumbnail}.srcObject===window.__thumbnailTest.stream`,
          );
          await b.js('document.querySelector(\'[aria-label="Show all streams"]\').click()');
          await b.wait(`document.querySelector('#screen-participants').hidden && !${thumbnail}`);
          await b.js('document.querySelector(\'[aria-label="Focus shared screen"]\').click()');
          await b.wait(thumbnail + '?.videoWidth>0');
          await b.js('delete window.__thumbnailTest');
        }
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
          "window.__screenTest.peers.filter(peer=>peer.connectionState!=='closed').flatMap(peer=>peer.getSenders()).some(sender=>sender.track?.kind==='video'&&sender.getParameters().encodings[0]?.maxFramerate>0&&sender.getParameters().encodings[0]?.maxFramerate<=15)",
        );
        if (fanoutCase) {
          for (const browser of browsers.slice(2)) {
            // Bound this ten-client correctness fixture's encoder load. The
            // publisher retains 720p60; high-rate fan-out needs a separate hardware budget.
            if (sound === 'nine') await choose(browser, 'Watch frame rate', '15');
            await browser.wait(
              "[...document.querySelectorAll('.screen-share-item')].some(item=>item.textContent.includes('Screen owner'))",
            );
            await browser.js(
              "document.querySelector('.screen-watch input[type=checkbox]').click()",
            );
            await browser.js(
              "[...document.querySelectorAll('.screen-share-item')].find(item=>item.textContent.includes('Screen owner')).querySelector('.screen-share-action').click()",
            );
            await browser.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
          }
          await a.wait(
            `document.querySelector('.screen-status').textContent.includes('${viewerCount} viewers')`,
          );
          const fanout = (await a.js(
            "window.__screenTest.peers.filter(peer=>peer.connectionState!=='closed').flatMap(peer=>peer.getSenders()).filter(sender=>sender.track?.kind==='video').map(sender=>sender.getParameters().encodings[0].maxBitrate)",
          )) as number[];
          expect(fanout).toHaveLength(viewerCount);
          expect(fanout.filter((cap) => cap === 2000000)).toHaveLength(1);
          expect(fanout.filter((cap) => cap === 4000000)).toHaveLength(viewerCount - 1);
          const secondPublisher = browsers[2]!;
          await secondPublisher.js(
            'document.querySelector(\'[aria-label="Open stream settings"]\').click()',
          );
          await secondPublisher.click('Prepare source');
          await secondPublisher.wait(
            "document.querySelector('#screen-panel')?.dataset.prepared==='true'",
          );
          await secondPublisher.click('Choose source');
          await secondPublisher.wait(
            "document.querySelector('#screen-panel')?.dataset.phase==='preview'",
          );
          expect(
            await secondPublisher.js("!document.querySelector('.screen-local-tile').hidden"),
          ).toBe(true);
          await secondPublisher.click('Start sharing');
          await b.wait("document.querySelectorAll('.screen-share-item').length===2");
          await b.js(
            "[...document.querySelectorAll('.screen-share-item')].find(item=>item.textContent.includes('Screen viewer 2')).querySelector('.screen-share-multi').click()",
          );
          await b.wait(
            "document.querySelectorAll('[data-screen-playback]').length===2 && [...document.querySelectorAll('[data-screen-playback]')].every(video=>video.videoWidth>0)",
          );
          expect(await b.js("document.querySelector('#screen-panel').dataset.layout")).toBe('grid');
        }
        const shareId = server.voice!.leases.get(publisher.auth.user.id)!.id;
        const beforeVoice = sound === 'nine' ? await voiceBytes() : [];
        const beforeRenewals = new Map(renewals);
        // Cross the original 45-second bind/source/link deadline without recapture.
        await new Promise<void>((resolve) => setTimeout(resolve, 47000));
        if (sound === 'nine') {
          const afterVoice = await voiceBytes();
          for (let index = 0; index < browsers.length; index++)
            expect(afterVoice[index]!).toBeGreaterThan(beforeVoice[index]!);
        }
        expect(renewals.size).toBe(browsers.length);
        for (const [id, count] of renewals) {
          const elapsed = count - (beforeRenewals.get(id) ?? 0);
          expect(elapsed).toBeGreaterThanOrEqual(4);
          expect(elapsed).toBeLessThanOrEqual(6);
        }
        expect(await a.js("document.querySelector('#screen-panel').dataset.phase")).toBe('sharing');
        expect(await a.js('window.__screenTest.calls')).toBe(1);
        expect(server.voice!.leases.get(publisher.auth.user.id)!.id).toBe(shareId);
        expect(
          await b.js("document.querySelector('[data-screen-playback]').videoWidth"),
        ).toBeGreaterThan(0);
        cleanupGate = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        await b.js(
          "Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'))",
        );
        await b.wait("!document.querySelector('[data-screen-playback]')");
        await vi.waitFor(() => expect(cleanupSeen).toBe(true));
        expect(await a.js('window.__screenTest.tracks[0].readyState')).toBe('live');
        await b.js(
          "Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'))",
        );
        expect(await b.js("!!document.querySelector('[data-screen-playback]')")).toBe(false);
        expect(
          await b.js("document.querySelector('#screen-panel [role=alert]')?.textContent ?? ''"),
        ).toBe('');
        releaseCleanup!();
        cleanupGate = undefined;
        await b.wait("document.querySelector('[data-screen-playback]')?.videoWidth>0");
        await a.wait(
          "window.__screenTest.peers.filter(peer=>peer.connectionState!=='closed').flatMap(peer=>peer.getSenders()).some(sender=>sender.track?.kind==='video'&&sender.getParameters().encodings[0]?.maxFramerate>0&&sender.getParameters().encodings[0]?.maxFramerate<=15)",
        );
        const artifacts = fileURLToPath(new URL('../../../../../artifacts', import.meta.url));
        await mkdir(artifacts, { recursive: true });
        const screenshot = (await b.call('Page.captureScreenshot')) as { data: string };
        await writeFile(
          artifacts + '/screen-sharing-ui.png',
          Buffer.from(screenshot.data, 'base64'),
        );
        if (fanoutCase) {
          await b.wait(
            "document.querySelectorAll('[data-screen-playback]').length===2 && [...document.querySelectorAll('[data-screen-playback]')].every(video=>video.videoWidth>0)",
          );
          expect(await b.js("document.querySelector('#screen-panel').dataset.layout")).toBe('grid');
          await browsers[2]!.js(
            'document.querySelector(\'[aria-label="Stop screen sharing"]\').click()',
          );
          await b.wait("document.querySelectorAll('[data-screen-playback]').length===1");
        }
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
      } catch (cause) {
        const diagnostics = await Promise.allSettled(
          browsers.map((browser) =>
            browser.js(
              "({phase:document.querySelector('#screen-panel')?.dataset.phase,error:document.querySelector('.screen-error')?.textContent,peers:window.__screenTest.peers.map(peer=>({connection:peer.connectionState,signaling:peer.signalingState}))})",
            ),
          ),
        );
        console.error('Owned screen fixture failure state:', JSON.stringify(diagnostics));
        console.error(
          'Screen command failures/slow replies:',
          JSON.stringify(commandDiagnostics.filter((item) => item.code || item.ms > 1000)),
        );
        throw cause;
      } finally {
        releaseCleanup?.();
        for (const browser of browsers) await browser.close();
        await server.app.close();
        for (const room of await server.voice!.media.listRooms())
          if (room.name.startsWith(prefix)) await server.voice!.media.deleteRoom(room.name);
        await database.cleanup();
      }
    },
    sound === 'nine' ? 240000 : 120000,
  );
}
