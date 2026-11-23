import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';
import { AuthService } from '../auth/service.js';
import { testDatabase } from '../db/test-database.js';
import { launch, setup, type Browser } from '../voice/browser-harness.js';
import { checkVoiceTestServices } from '../voice/test-services.js';

export async function startSharedVoiceFixture(target: number, proxy: number) {
  const origin = 'http://127.0.0.1:3011';
  console.log('Shared upload: checking local LiveKit and PostgreSQL.');
  const config = await checkVoiceTestServices();
  const fixture = await testDatabase();
  const prefix = 'obs-uplink-' + randomUUID() + '-';
  const server = createApp({
    databaseUrl: fixture.url,
    allowedOrigins: [origin],
    staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
    voiceConfig: { ...config, prefix },
  });
  const browsers: Browser[] = [];
  const close = async () => {
    await Promise.all(browsers.map((browser) => browser.close()));
    await server.app.close();
    for (const room of await server.voice!.media.listRooms())
      if (room.name.startsWith(prefix)) await server.voice!.media.deleteRoom(room.name);
    await fixture.cleanup();
  };
  try {
    await server.app.listen({ host: '127.0.0.1', port: 3011 });
    const auth = new AuthService(fixture.database.pool);
    const password = randomUUID() + 'Aa3!';
    await auth.bootstrap('uplink_publisher', 'Upload publisher', password);
    const publisher = await auth.login(
      { username: 'uplink_publisher', password, remember: false },
      undefined,
    );
    const guest = await auth.register({
      username: 'uplink_receiver',
      displayName: 'Upload receiver',
      password,
    });
    await auth.changeStatus(publisher.token, guest.id, 'approve');
    const receiver = await auth.login(
      { username: 'uplink_receiver', password, remember: false },
      undefined,
    );
    console.log('Shared upload: connecting two synthetic voice participants.');
    for (const token of [receiver.token, publisher.token]) {
      const browser = await launch({ fakeMicrophone: true, loopbackIce: true });
      browsers.push(browser);
      console.log(token === publisher.token ? 'Voice publisher opened.' : 'Voice receiver opened.');
      const source = `(() => {
        const oldAdd = RTCPeerConnection.prototype.addIceCandidate;
        const oldRemote = RTCPeerConnection.prototype.setRemoteDescription;
        const candidate = new RegExp('( UDP [0-9]+ )[^ ]+ ' + ${target} + '(?= typ )', 'gi');
        const rewrite = value => value.replace(candidate, (_, prefix) => prefix + '127.0.0.1 ' + ${proxy});
        RTCPeerConnection.prototype.addIceCandidate = function(item) {
          if (!item?.candidate) return oldAdd.call(this, item);
          const plain = item.toJSON?.() ?? item;
          return oldAdd.call(this, {...plain, candidate: rewrite(plain.candidate)});
        };
        RTCPeerConnection.prototype.setRemoteDescription = function(value) {
          return oldRemote.call(this, {type: value.type, sdp: rewrite(value.sdp ?? '')});
        };
      })()`;
      if (token === publisher.token)
        await browser.call('Page.addScriptToEvaluateOnNewDocument', { source });
      try {
        await setup(browser, token, origin);
      } catch (cause) {
        const ice = await browser.js(`Promise.all(window.__peers.map(async peer => {
          const stats = [...(await peer.getStats()).values()];
          return {
            state: peer.iceConnectionState,
            remote: stats.filter(row => row.type === 'remote-candidate').map(row =>
              [row.candidateType, row.protocol, row.port]),
            checks: stats.filter(row => row.type === 'candidate-pair').map(row =>
              [row.state, row.requestsSent, row.responsesReceived])
          };
        }))`);
        console.error('Shared upload ICE diagnostics:', JSON.stringify(ice));
        throw new Error('Could not join the disposable voice room.', { cause });
      }
      console.log(token === publisher.token ? 'Voice publisher joined.' : 'Voice receiver joined.');
    }
    await browsers[1]!.js(
      'document.querySelector(\'button[aria-label="Unmute microphone"]\')?.click()',
    );
    const inbound = `(async () => {
      const reports = await Promise.all(window.__peers.map(peer => peer.getStats()));
      for (const report of reports) {
        const audio = [...report.values()].find(item => item.type === 'inbound-rtp' &&
          item.kind === 'audio' && item.packetsReceived > 0);
        if (audio) return {
          time: performance.now(), packets: audio.packetsReceived, lost: audio.packetsLost,
          samples: audio.totalSamplesReceived, concealed: audio.concealedSamples,
          jitterMs: audio.jitter * 1000, jitterDelay: audio.jitterBufferDelay,
          jitterSamples: audio.jitterBufferEmittedCount
        };
      }
    })()`;
    await browsers[0]!.wait(inbound);
    const selectedPort = await browsers[1]!.js(`(async () => {
      const reports = await Promise.all(window.__peers.map(peer => peer.getStats()));
      for (const report of reports) {
        const audio = [...report.values()].find(item => item.type === 'outbound-rtp' &&
          item.kind === 'audio' && item.packetsSent > 0);
        if (audio) {
          const pair = report.get(report.get(audio.transportId)?.selectedCandidatePairId);
          return report.get(pair?.remoteCandidateId)?.port;
        }
      }
    })()`);
    assert.equal(selectedPort, proxy, 'Voice publisher must use the same shaped upload.');
    console.log('Shared upload: verified routed voice packets.');
    return { sample: () => browsers[0]!.js(inbound), close };
  } catch (cause) {
    console.error(
      'Shared upload voice setup failed:',
      cause instanceof Error ? cause.message : String(cause),
    );
    await close();
    throw new Error('Could not start the shared-upload voice fixture.', { cause });
  }
}

if (process.send && process.argv[2] === '--shared-upload') {
  const target = Number(process.argv[3]),
    proxy = Number(process.argv[4]);
  assert([target, proxy].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535));
  const voice = await startSharedVoiceFixture(target, proxy);
  let closing: Promise<void> | undefined;
  const stop = async () => {
    closing ??= voice.close();
    await closing;
    if (process.connected) process.disconnect();
  };
  process.once('disconnect', () => {
    void stop();
  });
  process.on('message', (action) => {
    if (action === 'stop') void stop();
    if (action === 'sample' && !closing) {
      void voice.sample().then(
        (sample) => process.send?.({ sample }),
        (cause: unknown) =>
          process.send?.({
            error: cause instanceof Error ? cause.message : 'Voice sample failed.',
          }),
      );
    }
  });
  process.send({ ready: true });
}
