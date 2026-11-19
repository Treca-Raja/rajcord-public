import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, type Browser } from '../voice/browser-harness.js';
import { fixtureHtml } from './feasibility-page.js';
import { createScreenNetworkFixture } from './network-fixture.js';
import { delta, type Counters } from './feasibility-metrics.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const network = await createScreenNetworkFixture();
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(fixtureHtml());
});
const browsers: Browser[] = [];
let failure: unknown;
const errors: unknown[] = [];
type Snapshot = {
  time: number;
  connection: string;
  audioRms: number | null;
  rendered: number;
  tracks: { readyState: string }[];
  route: { localType: string; remoteType: string } | null;
  rtp: Record<string, number | string>[];
};
const phases: unknown[] = [];
const counter = (snapshot: Snapshot, kind: string): Counters => {
  const video = snapshot.rtp.find((row) => row.type === 'inbound-rtp' && row.kind === kind);
  assert.ok(video, 'Required received media statistics absent');
  return {
    time: snapshot.time,
    bytes: Number(video.bytesReceived),
    frames: kind === 'video' ? Number(video.framesDecoded) : undefined,
    width: Number(video.frameWidth),
    height: Number(video.frameHeight),
  };
};
const invoke = (browser: Browser, method: string, ...args: unknown[]) =>
  browser.js(
    'window.screenFixture.' +
      method +
      '(' +
      args.map((value) => JSON.stringify(value)).join(',') +
      ')',
  );
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (let index = 0; index < 2; index++) {
    const browser = await launch({ fakeMicrophone: false });
    browsers.push(browser);
    await browser.call('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await browser.wait('!!window.screenFixture');
  }
  const [publisher, receiver] = browsers as [Browser, Browser];
  await invoke(publisher, 'capture', 'canvas', 'motion');
  await invoke(publisher, 'create', true, 'VP8', 'motion', network.configuration);
  await invoke(receiver, 'create', false, 'VP8', 'motion', network.configuration);
  const offer = await invoke(publisher, 'offer');
  const answer = await invoke(receiver, 'answer', offer);
  await invoke(publisher, 'accept', answer);
  let connected = false;
  let candidateCount = 0;
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const [from, to] of [
      [publisher, receiver],
      [receiver, publisher],
    ] as const) {
      const ice = (await invoke(from, 'ice')) as { candidates: unknown[] };
      candidateCount += ice.candidates.length;
      await invoke(to, 'addIce', ice.candidates);
    }
    const snapshot = (await invoke(receiver, 'snapshot')) as {
      connection: string;
      rtp: { kind: string; framesDecoded?: number }[];
    };
    last = snapshot;
    if (
      snapshot.connection === 'connected' &&
      snapshot.rtp.some((row) => row.kind === 'video' && row.framesDecoded! > 0)
    ) {
      connected = true;
      break;
    }
    await delay(100);
  }
  assert.ok(
    connected,
    'Owned loopback relay media must connect: ' +
      JSON.stringify({ ...network.inspect(), candidateCount, last }),
  );
  await invoke(receiver, 'play');
  await invoke(publisher, 'cap', 8000000, 'motion', 'motion');
  for (const profile of [
    { name: 'baseline', duration: 4000, lossEvery: 0, bitrate: 0, delayMs: 0, jitterMs: 0 },
    {
      name: 'constrained',
      duration: 10000,
      lossEvery: 10,
      bitrate: 800000,
      delayMs: 25,
      jitterMs: 15,
    },
    {
      name: 'burst-loss',
      duration: 3000,
      lossEvery: 2,
      bitrate: 800000,
      delayMs: 25,
      jitterMs: 15,
    },
    { name: 'recovered', duration: 10000, lossEvery: 0, bitrate: 0, delayMs: 0, jitterMs: 0 },
  ]) {
    network.conditions(profile);
    const before = (await invoke(receiver, 'snapshot')) as Snapshot,
      beforeNetwork = network.inspect();
    await delay(profile.duration);
    const after = (await invoke(receiver, 'snapshot')) as Snapshot,
      afterNetwork = network.inspect();
    const video = delta(counter(before, 'video'), counter(after, 'video')),
      audio = delta(counter(before, 'audio'), counter(after, 'audio'));
    assert.equal(after.connection, 'connected', 'Synthetic loss must not end the media connection');
    assert.equal(after.route?.localType, 'relay');
    assert.equal(after.route?.remoteType, 'relay');
    if (profile.name !== 'burst-loss')
      assert.ok(
        Number(video.fps) > 0 && audio.bitsPerSecond > 0 && Number(after.audioRms) > 0,
        'Video and source sound must continue or recover',
      );
    if (profile.lossEvery)
      assert.ok(
        afterNetwork.droppedPackets > beforeNetwork.droppedPackets,
        'Loss must be measured at the datagram fixture',
      );
    phases.push({
      profile,
      video,
      audio,
      route: after.route,
      network: afterNetwork,
      received: after.rtp,
      rendered: after.rendered - before.rendered,
    });
    console.log('Measured network phase:', profile.name, {
      videoFps: video.fps,
      videoBitrate: video.bitsPerSecond,
      dropped: afterNetwork.droppedPackets - beforeNetwork.droppedPackets,
    });
  }
  const final = (await invoke(publisher, 'snapshot')) as Snapshot;
  assert.ok(
    final.tracks.length === 2 && final.tracks.every((track) => track.readyState === 'live'),
    'The consented synthetic source must remain live',
  );
  const outgoing = final.rtp.find((row) => row.type === 'outbound-rtp' && row.kind === 'video');
  assert.ok(
    Number(outgoing?.retransmittedPacketsSent) > 0,
    'Native RTP retransmission must be observed',
  );
  assert.deepEqual(network.inspect().errors, []);
} catch (cause) {
  failure = cause;
} finally {
  if (failure) errors.push(failure);
  const clean = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      errors.push(cause);
    }
  };
  for (const browser of browsers) {
    await clean(async () => {
      const result = await browser.js('window.screenFixture ? window.screenFixture.stop() : null');
      if (result)
        assert.ok(
          Object.values(result as Record<string, boolean>).every(Boolean),
          'Owned tracks and peer must end',
        );
    });
    await clean(() => browser.close());
  }
  await clean(() => network.close());
  server.closeAllConnections();
  await clean(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await clean(async () => {
    assert.equal(network.inspect().allocations, 0);
    assert.equal(network.inspect().queued, 0);
  });
  const directory = fileURLToPath(new URL('../../../../artifacts/screen/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/network-' + Date.now() + '.json',
    JSON.stringify(
      {
        scope: 'owned synthetic loopback relay, not production TURN or WAN qualification',
        failure: failure instanceof Error ? failure.message : null,
        phases,
        cleanup: network.inspect(),
      },
      null,
      2,
    ) + '\n',
  );
}
if (errors.length) throw new AggregateError(errors, 'Owned network fixture failed.');
console.log(
  'PASS: native relay media under measured loss, bandwidth limits, jitter and recovery; cleanup complete.',
);
