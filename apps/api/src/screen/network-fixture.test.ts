import { expect, it, vi } from 'vitest';
import { createSocket, type Socket } from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createScreenNetworkFixture } from './network-fixture';
const attr = (type: number, data: Buffer) => {
  const value = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  value.writeUInt16BE(type);
  value.writeUInt16BE(data.length, 2);
  data.copy(value, 4);
  return value;
};
const packet = (type: number, attrs: Buffer[], key?: Buffer) => {
  const body = Buffer.concat(attrs),
    header = Buffer.alloc(20);
  header.writeUInt16BE(type);
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  header.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(header, 8);
  const prefix = Buffer.concat([header, body]);
  return key
    ? Buffer.concat([prefix, attr(8, createHmac('sha1', key).update(prefix).digest())])
    : prefix;
};
const fields = (value: Buffer) => {
  const result = new Map<number, Buffer>();
  for (let offset = 20; offset + 4 <= value.length;) {
    const size = value.readUInt16BE(offset + 2);
    result.set(value.readUInt16BE(offset), value.subarray(offset + 4, offset + 4 + size));
    offset += 4 + Math.ceil(size / 4) * 4;
  }
  return result;
};
const exchange = (socket: Socket, port: number, value: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', receive);
      reject(new Error('Owned relay response timed out'));
    }, 1000);
    const receive = (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once('message', receive);
    socket.send(value, port, '127.0.0.1');
  });

it('requires ephemeral TURN authentication and refuses recipients outside its own allocations', async () => {
  const fixture = await createScreenNetworkFixture(),
    client = createSocket('udp4'),
    outside = createSocket('udp4');
  let outsidePackets = 0;
  outside.on('message', () => outsidePackets++);
  try {
    await new Promise<void>((resolve) => outside.bind(0, '127.0.0.1', resolve));
    const server = fixture.configuration.iceServers[0]!;
    const port = Number(server.urls.match(/:(\d+)\?/)![1]);
    const challenge = await exchange(client, port, packet(3, []));
    expect(challenge.readUInt16BE()).toBe(0x0113);
    expect(fixture.inspect().allocations).toBe(0);
    const realm = fields(challenge).get(0x14)!,
      nonce = fields(challenge).get(0x15)!;
    const attrs = [
      attr(6, Buffer.from(server.username)),
      attr(0x14, realm),
      attr(0x15, nonce),
      attr(0x19, Buffer.from([17, 0, 0, 0])),
    ];
    expect((await exchange(client, port, packet(3, attrs, Buffer.alloc(16)))).readUInt16BE()).toBe(
      0x0113,
    );
    expect(fixture.inspect().allocations).toBe(0);
    const key = createHash('md5')
      .update(server.username + ':' + realm.toString() + ':' + server.credential)
      .digest();
    const unsignedOverride = Buffer.concat([
      packet(
        3,
        [
          attr(6, Buffer.from(server.username)),
          attr(0x14, Buffer.from('wrong-realm')),
          attr(0x15, nonce),
        ],
        key,
      ),
      attr(0x14, realm),
    ]);
    unsignedOverride.writeUInt16BE(unsignedOverride.length - 20, 2);
    expect((await exchange(client, port, unsignedOverride)).readUInt16BE()).toBe(0x0113);
    expect(fixture.inspect().allocations).toBe(0);
    const allocated = await exchange(client, port, packet(3, attrs, key));
    expect(allocated.readUInt16BE()).toBe(0x0103);
    expect(fixture.inspect().allocations).toBe(1);
    expect((await exchange(client, port, packet(3, attrs, key))).readUInt16BE()).toBe(0x0103);
    expect(fixture.inspect().allocations).toBe(1);
    const address = Buffer.alloc(8);
    address[1] = 1;
    address.writeUInt16BE(outside.address().port ^ 0x2112, 2);
    address.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 4);
    client.send(
      packet(0x16, [attr(0x12, address), attr(0x13, Buffer.from([0x80, 0x60, 1, 2]))]),
      port,
      '127.0.0.1',
    );
    await vi.waitFor(() => expect(fixture.inspect().rejectedRecipients).toBe(1));
    expect(outsidePackets).toBe(0);
    expect(fixture.inspect().forwardedPackets).toBe(0);
    expect(() =>
      fixture.conditions({ lossEvery: 1, bitrate: Infinity, delayMs: 0, jitterMs: 0 }),
    ).toThrow();
  } finally {
    client.close();
    outside.close();
    await fixture.close();
    await fixture.close();
  }
  expect(fixture.inspect()).toMatchObject({ allocations: 0, queued: 0, closed: true, errors: [] });
});
