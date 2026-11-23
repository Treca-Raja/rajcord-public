// Test-only TURN subset for encrypted synthetic media. Never imported by app.ts.
// All sockets bind to loopback and may relay only to this fixture's allocations.
import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const cookie = 0x2112a442;
function attribute(type: number, value: Buffer) {
  const result = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  result.writeUInt16BE(type);
  result.writeUInt16BE(value.length, 2);
  value.copy(result, 4);
  return result;
}
function message(type: number, transaction: Buffer, attributes: Buffer[]) {
  const body = Buffer.concat(attributes),
    header = Buffer.alloc(20);
  header.writeUInt16BE(type);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(cookie, 4);
  transaction.copy(header, 8);
  return Buffer.concat([header, body]);
}
function address(port: number) {
  const value = Buffer.alloc(8);
  value[1] = 1;
  value.writeUInt16BE(port ^ (cookie >>> 16), 2);
  value.writeUInt32BE((0x7f000001 ^ cookie) >>> 0, 4);
  return value;
}
const lifetime = (seconds = 600) => {
  const value = Buffer.alloc(4);
  value.writeUInt32BE(seconds);
  return value;
};
type MediaFlow = {
  sequence: number;
  next: number;
  timers: Set<ReturnType<typeof setTimeout>>;
};
type Allocation = MediaFlow & {
  socket: Socket;
  port: number;
  client: RemoteInfo;
  channels: Map<number, number>;
};
export type NetworkConditions = Readonly<{
  lossEvery: number;
  bitrate: number;
  delayMs: number;
  jitterMs: number;
  sharedUpload?: boolean;
}>;
export async function createScreenNetworkFixture() {
  const control = createSocket('udp4'),
    clients = new Map<number, Allocation>(),
    relays = new Map<number, Allocation>();
  const pending = new Set<Promise<void>>();
  const allocating = new Map<number, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const username = randomBytes(12).toString('hex'),
    password = randomBytes(16).toString('hex');
  const realm = 'rajcord-owned-network-fixture',
    nonce = randomBytes(16).toString('hex');
  const key = createHash('md5').update(`${username}:${realm}:${password}`).digest();
  const authenticated = (packet: Buffer, offset: number) => {
    const header = Buffer.from(packet.subarray(0, offset));
    header.writeUInt16BE(offset + 24 - 20, 2);
    return createHmac('sha1', key).update(header).digest();
  };
  const response = (type: number, transaction: Buffer, attributes: Buffer[]) => {
    const packet = message(type, transaction, [...attributes, attribute(0x0008, Buffer.alloc(20))]);
    authenticated(packet, packet.length - 24).copy(packet, packet.length - 20);
    return packet;
  };
  let conditions: NetworkConditions = { lossEvery: 0, bitrate: 0, delayMs: 0, jitterMs: 0 };
  let sharedNext = 0;
  let phaseMaxQueueMs = 0;
  const mediaCounters = () => ({
    mediaPackets: 0,
    mediaBytes: 0,
    droppedPackets: 0,
    queueDroppedPackets: 0,
    forwardedPackets: 0,
    forwardedBytes: 0,
    maxQueueMs: 0,
  });
  const counters = { ...mediaCounters(), rejectedRecipients: 0, releasedAllocations: 0 };
  const voice = mediaCounters();
  const voiceFlows = new Map<string, MediaFlow & { socket: Socket }>();
  let voiceEntry: Socket | undefined;
  const errors: string[] = [];
  const requests: Record<string, number> = {};
  const error = (cause: Error & { code?: string }) => {
    if (errors.length < 16) errors.push(cause.code ?? 'udp-error');
  };
  control.on('error', error);
  const send = (socket: Socket, packet: Buffer, port: number) => {
    if (!closed)
      socket.send(packet, port, '127.0.0.1', (cause) => {
        if (cause && !closed) error(cause);
      });
  };
  const deliver = (allocation: Allocation, packet: Buffer, peer: number) => {
    const channel = [...allocation.channels].find(([, port]) => port === peer)?.[0];
    if (channel !== undefined) {
      const header = Buffer.alloc(4);
      header.writeUInt16BE(channel);
      header.writeUInt16BE(packet.length, 2);
      send(control, Buffer.concat([header, packet]), allocation.client.port);
    } else
      send(
        control,
        message(0x0017, randomBytes(12), [
          attribute(0x0012, address(peer)),
          attribute(0x0013, packet),
        ]),
        allocation.client.port,
      );
  };
  const scheduleMedia = (
    flow: MediaFlow,
    packet: Buffer,
    metrics: ReturnType<typeof mediaCounters>,
    deliver: () => boolean,
  ) => {
    const media = packet.length > 1 && (packet[0]! & 0xc0) === 0x80;
    if (!media) {
      deliver();
      return;
    }
    metrics.mediaPackets++;
    metrics.mediaBytes += packet.length;
    flow.sequence++;
    if (conditions.lossEvery && flow.sequence % conditions.lossEvery === 0) {
      metrics.droppedPackets++;
      return;
    }
    const now = performance.now();
    const ready = Math.max(now, conditions.sharedUpload ? sharedNext : flow.next);
    const queued = ready - now;
    if (flow.timers.size >= 256 || queued > 250) {
      metrics.queueDroppedPackets++;
      return;
    }
    flow.next = ready + (conditions.bitrate ? (packet.length * 8000) / conditions.bitrate : 0);
    if (conditions.sharedUpload) sharedNext = flow.next;
    metrics.maxQueueMs = Math.max(metrics.maxQueueMs, queued);
    phaseMaxQueueMs = Math.max(phaseMaxQueueMs, queued);
    const delay = Math.max(
      0,
      queued + conditions.delayMs + ((flow.sequence % 3) - 1) * conditions.jitterMs,
    );
    const deliverMedia = () => {
      if (closed || !deliver()) return;
      metrics.forwardedPackets++;
      metrics.forwardedBytes += packet.length;
    };
    if (!delay) {
      deliverMedia();
      return;
    }
    const timer = setTimeout(() => {
      flow.timers.delete(timer);
      deliverMedia();
    }, delay);
    flow.timers.add(timer);
  };
  const forward = (allocation: Allocation, packet: Buffer, target: number) => {
    if (!relays.has(target)) {
      counters.rejectedRecipients++;
      return;
    }
    scheduleMedia(allocation, packet, counters, () => {
      if (clients.get(allocation.client.port) !== allocation) return false;
      send(allocation.socket, packet, target);
      return true;
    });
  };
  const allocate = async (client: RemoteInfo) => {
    if (closed || clients.size + allocating.size >= 20 || clients.has(client.port)) return;
    const socket = createSocket('udp4');
    socket.on('error', error);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    if (closed) {
      socket.close();
      return;
    }
    const port = socket.address().port;
    const allocation: Allocation = {
      socket,
      port,
      client,
      channels: new Map(),
      sequence: 0,
      next: 0,
      timers: new Set(),
    };
    clients.set(client.port, allocation);
    relays.set(port, allocation);
    socket.on('message', (packet, peer) => {
      if (peer.address !== '127.0.0.1' || !relays.has(peer.port) || packet.length > 16384) {
        counters.rejectedRecipients++;
        return;
      }
      deliver(allocation, packet, peer.port);
    });
  };
  control.on('message', (packet, client) => {
    if (closed || client.address !== '127.0.0.1' || packet.length < 4 || packet.length > 16384)
      return;
    const type = packet.readUInt16BE();
    requests[type.toString(16)] = (requests[type.toString(16)] ?? 0) + 1;
    if ((type & 0xc000) === 0x4000) {
      const allocation = clients.get(client.port),
        target = allocation?.channels.get(type);
      const length = packet.readUInt16BE(2);
      if (allocation && target !== undefined && length <= packet.length - 4)
        forward(allocation, packet.subarray(4, 4 + length), target);
      return;
    }
    if (
      packet.length < 20 ||
      packet.readUInt32BE(4) !== cookie ||
      packet.readUInt16BE(2) + 20 !== packet.length
    )
      return;
    const attributes = new Map<number, Buffer>();
    let integrity = -1;
    for (let offset = 20; offset + 4 <= packet.length;) {
      const length = packet.readUInt16BE(offset + 2);
      if (offset + 4 + length > packet.length) return;
      attributes.set(packet.readUInt16BE(offset), packet.subarray(offset + 4, offset + 4 + length));
      if (packet.readUInt16BE(offset) === 0x0008) {
        if (length !== 20) return;
        integrity = offset;
        break;
      }
      offset += 4 + Math.ceil(length / 4) * 4;
    }
    const transaction = packet.subarray(8, 20);
    if (type === 0x0001) {
      send(
        control,
        message(0x0101, transaction, [attribute(0x0020, address(client.port))]),
        client.port,
      );
      return;
    }
    if (
      [0x0003, 0x0004, 0x0008, 0x0009].includes(type) &&
      (attributes.get(0x0006)?.toString() !== username ||
        attributes.get(0x0014)?.toString() !== realm ||
        attributes.get(0x0015)?.toString() !== nonce ||
        integrity < 20 ||
        !timingSafeEqual(authenticated(packet, integrity), attributes.get(0x0008)!))
    ) {
      const code = Buffer.from([0, 0, 4, 1]);
      send(
        control,
        message(type | 0x0110, transaction, [
          attribute(0x0009, code),
          attribute(0x0014, Buffer.from(realm)),
          attribute(0x0015, Buffer.from(nonce)),
        ]),
        client.port,
      );
      return;
    }
    const work = (async () => {
      if (type === 0x0003 && !clients.has(client.port)) {
        let creation = allocating.get(client.port);
        if (!creation) {
          creation = allocate(client);
          allocating.set(client.port, creation);
        }
        try {
          await creation;
        } finally {
          if (allocating.get(client.port) === creation) allocating.delete(client.port);
        }
      }
      const allocation = clients.get(client.port);
      if (closed || !allocation) return;
      if (type === 0x0003)
        send(
          control,
          response(0x0103, transaction, [
            attribute(0x0016, address(allocation.port)),
            attribute(0x0020, address(client.port)),
            attribute(0x000d, lifetime()),
          ]),
          client.port,
        );
      else if (type === 0x0004) {
        const duration = attributes.get(0x000d);
        const releasing = duration?.length === 4 && duration.readUInt32BE() === 0;
        send(
          control,
          response(0x0104, transaction, [attribute(0x000d, lifetime(releasing ? 0 : 600))]),
          client.port,
        );
        if (releasing) {
          clients.delete(client.port);
          relays.delete(allocation.port);
          for (const timer of allocation.timers) clearTimeout(timer);
          allocation.socket.close();
          counters.releasedAllocations++;
        }
      } else if ([0x0008, 0x0009, 0x0016].includes(type)) {
        const peer = attributes.get(0x0012);
        if (
          !peer ||
          peer.length !== 8 ||
          peer[1] !== 1 ||
          (peer.readUInt32BE(4) ^ cookie) >>> 0 !== 0x7f000001
        ) {
          counters.rejectedRecipients++;
          return;
        }
        const target = peer.readUInt16BE(2) ^ (cookie >>> 16);
        if (!relays.has(target)) {
          counters.rejectedRecipients++;
          return;
        }
        if (type === 0x0009) {
          const channel = attributes.get(0x000c);
          if (
            !channel ||
            channel.length !== 4 ||
            channel.readUInt16BE() < 0x4000 ||
            channel.readUInt16BE() > 0x7fff ||
            allocation.channels.size >= 20
          )
            return;
          allocation.channels.set(channel.readUInt16BE(), target);
        }
        if (type === 0x0016) {
          const data = attributes.get(0x0013);
          if (data) forward(allocation, data, target);
        } else send(control, response(type | 0x0100, transaction, []), client.port);
      }
    })();
    pending.add(work);
    void work.catch(error).finally(() => pending.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.bind(0, '127.0.0.1', () => {
      control.removeListener('error', reject);
      resolve();
    });
  });
  return {
    configuration: {
      iceTransportPolicy: 'relay' as const,
      iceServers: [
        {
          urls: `turn:127.0.0.1:${control.address().port}?transport=udp`,
          username,
          credential: password,
        },
      ],
    },
    conditions(value: NetworkConditions) {
      if (
        ![value.lossEvery, value.bitrate, value.delayMs, value.jitterMs].every(Number.isFinite) ||
        !Number.isInteger(value.lossEvery) ||
        value.lossEvery < 0 ||
        value.bitrate < 0 ||
        value.delayMs < 0 ||
        value.delayMs > 500 ||
        value.jitterMs < 0 ||
        value.jitterMs > 100
      )
        throw new Error('Invalid synthetic network conditions.');
      conditions = Object.freeze({ ...value });
      sharedNext = 0;
      phaseMaxQueueMs = 0;
      for (const allocation of clients.values()) allocation.next = 0;
      for (const flow of voiceFlows.values()) flow.next = 0;
    },
    async voiceUpload(target: number) {
      if (closed || voiceEntry || !Number.isInteger(target) || target < 1024 || target > 65535)
        throw new Error('Invalid local voice media proxy.');
      const entry = (voiceEntry = createSocket('udp4'));
      const local = new Set([
        '127.0.0.1',
        ...Object.values(networkInterfaces())
          .flat()
          .filter((item) => item?.family === 'IPv4')
          .map((item) => item?.address),
      ]);
      entry.on('error', error);
      entry.on('message', (packet, peer) => {
        if (closed || !local.has(peer.address) || packet.length > 16384) return;
        const id = peer.address + ':' + peer.port;
        let flow = voiceFlows.get(id);
        if (!flow) {
          if (voiceFlows.size >= 8) return;
          const socket = createSocket('udp4');
          flow = { socket, sequence: 0, next: 0, timers: new Set() };
          voiceFlows.set(id, flow);
          socket.on('error', error);
          socket.on('message', (response, remote) => {
            if (!closed && remote.address === '127.0.0.1' && remote.port === target)
              entry.send(response, peer.port, peer.address);
          });
        }
        const socket = flow.socket;
        scheduleMedia(flow, packet, voice, () => {
          send(socket, packet, target);
          return true;
        });
      });
      await new Promise<void>((resolve, reject) => {
        entry.once('error', reject);
        entry.bind(0, '127.0.0.1', () => {
          entry.removeListener('error', reject);
          resolve();
        });
      });
      return entry.address().port;
    },
    inspect: () => ({
      ...counters,
      phaseMaxQueueMs,
      requests: { ...requests },
      errors: [...errors],
      ...(voiceEntry ? { voice: { ...voice } } : {}),
      allocations: clients.size,
      queued: [...clients.values()].reduce((sum, item) => sum + item.timers.size, 0),
      closed,
    }),
    close() {
      closing ??= (async () => {
        closed = true;
        await Promise.allSettled([...pending]);
        for (const allocation of clients.values())
          for (const timer of allocation.timers) clearTimeout(timer);
        await Promise.all(
          [...clients.values()].map(
            (allocation) =>
              new Promise<void>((resolve) => allocation.socket.close(() => resolve())),
          ),
        );
        clients.clear();
        relays.clear();
        for (const { timers } of voiceFlows.values())
          for (const timer of timers) clearTimeout(timer);
        await Promise.all(
          [...voiceFlows.values()].map(
            ({ socket }) => new Promise<void>((resolve) => socket.close(() => resolve())),
          ),
        );
        voiceFlows.clear();
        if (voiceEntry) await new Promise<void>((resolve) => voiceEntry!.close(() => resolve()));
        await new Promise<void>((resolve) => control.close(() => resolve()));
      })();
      return closing;
    },
  };
}
