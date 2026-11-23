// Raw TURN control checks against the isolated, loopback-only coturn fixture.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { screenRelayServers } from '../apps/api/dist/screen/relay.js';

const secret = process.env.SCREEN_COTURN_SECRET;
assert(secret && /^[a-f0-9]{64}$/.test(secret), 'An isolated coturn fixture is required.');
const cookie = 0x2112a442;
const socket = createSocket('udp4');
socket.connect(3479, '127.0.0.1');
function attr(type, bytes) {
  const padded = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4);
  padded.writeUInt16BE(type);
  padded.writeUInt16BE(bytes.length, 2);
  bytes.copy(padded, 4);
  return padded;
}
function request(type, attributes, auth, phase = 'request') {
  const payload = Buffer.concat(auth ? [...attributes, ...auth.attributes] : attributes);
  const header = Buffer.alloc(20);
  const id = randomBytes(12);
  header.writeUInt16BE(type);
  header.writeUInt16BE(payload.length + (auth ? 24 : 0), 2);
  header.writeUInt32BE(cookie, 4);
  id.copy(header, 8);
  const bare = Buffer.concat([header, payload]);
  const message = auth
    ? Buffer.concat([bare, attr(8, createHmac('sha1', auth.key).update(bare).digest())])
    : bare;
  return new Promise((resolve, reject) => {
    const retries = [650, 1950, 4550].map((ms) => setTimeout(() => socket.send(message), ms));
    const cleanup = () => {
      clearTimeout(timeout);
      for (const retry of retries) clearTimeout(retry);
      socket.off('message', receive);
    };
    const receive = (response) => {
      if (response.length < 20 || !response.subarray(8, 20).equals(id)) return;
      cleanup();
      const attrs = new Map();
      for (let pos = 20; pos + 4 <= response.length;) {
        const len = response.readUInt16BE(pos + 2);
        attrs.set(response.readUInt16BE(pos), response.subarray(pos + 4, pos + 4 + len));
        pos += 4 + Math.ceil(len / 4) * 4;
      }
      const error = attrs.get(9);
      resolve({
        type: response.readUInt16BE(),
        error: error && (error[2] & 7) * 100 + error[3],
        attrs,
      });
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Local coturn ${phase} (0x${type.toString(16)}) timed out.`));
    }, 5500);
    socket.on('message', receive);
    socket.send(message);
  });
}
function authenticate(now, challenge, altered = false) {
  const [, server] = screenRelayServers(
    { screenCoturn: { host: 'localhost', secret } },
    'control',
    now,
  );
  const realm = challenge.attrs.get(0x14);
  const nonce = challenge.attrs.get(0x15);
  assert(realm && nonce);
  return {
    attributes: [attr(6, Buffer.from(server.username)), attr(0x14, realm), attr(0x15, nonce)],
    key: createHash('md5')
      .update(`${server.username}:${realm.toString()}:${altered ? 'wrong' : server.credential}`)
      .digest(),
  };
}
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});
try {
  const udp = attr(0x19, Buffer.from([17, 0, 0, 0]));
  const start = Date.now();
  const challenge = await request(3, [udp], undefined, 'unauthenticated Allocate');
  assert.equal(challenge.error, 401);
  assert.equal(
    (await request(3, [udp], authenticate(start, challenge, true), 'bad credential')).error,
    401,
  );
  assert.equal(
    (await request(3, [udp], authenticate(start - 61000, challenge), 'expired credential')).error,
    401,
  );
  const active = authenticate(start, challenge);
  const allocation = await request(3, [udp], active, 'fresh allocation');
  assert.equal(allocation.type, 0x0103);
  assert(allocation.attrs.has(0x16));
  const lifetime = allocation.attrs.get(0x0d)?.readUInt32BE();
  const refresh = await request(4, [], active, 'default lifetime Refresh');
  assert.equal(refresh.type, 0x0104);
  const refreshedLifetime = refresh.attrs.get(0x0d)?.readUInt32BE();
  // CreatePermission only. The fixture never sends a datagram to this address.
  const metadata = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]);
  metadata.writeUInt16BE(80 ^ (cookie >>> 16), 2);
  metadata.writeUInt32BE((0xa9fea9fe ^ cookie) >>> 0, 4);
  assert.equal((await request(8, [attr(0x12, metadata)], active)).error, 403);
  const release = await request(4, [attr(0x0d, Buffer.alloc(4))], active);
  assert.equal(release.type, 0x0104);
  assert.equal(release.attrs.get(0x0d)?.readUInt32BE(), 0);
  console.log(JSON.stringify({ lifetime, refreshedLifetime }));
  assert(lifetime > 0 && lifetime <= 120);
  assert(refreshedLifetime > 0 && refreshedLifetime <= 120, 'Refresh exceeded the relay lifetime.');
  console.log(
    'PASS coturn control: unauthenticated, bad and expired access denied, fresh allocation and release, metadata permission denied.',
  );
} finally {
  socket.close();
}
