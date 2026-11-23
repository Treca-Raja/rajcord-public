import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';

// Windows ICE clients may use a local interface address when sending to a
// loopback TURN server. Preserve unique clients while enforcing local-only hops.
export async function bindLocalRelay(config) {
  const server = config.iceServers[0];
  const target = /^turn:127\.0\.0\.1:(\d+)\?transport=udp$/.exec(server.urls);
  assert(target);
  const port = Number(target[1]);
  const allowed = new Set([
    '127.0.0.1',
    ...Object.values(networkInterfaces())
      .flat()
      .filter((item) => item?.family === 'IPv4')
      .map((item) => item.address),
  ]);
  const clients = new Map();
  const entry = createSocket('udp4');
  const errors = [];
  const fail = (error) => {
    if (errors.length < 8) errors.push(error.code ?? 'socket-error');
  };
  entry.on('error', fail);
  let received = 0;
  let returned = 0;
  let blocked = 0;
  let offline = false;
  entry.on('message', (packet, remote) => {
    if (!allowed.has(remote.address) || packet.length < 4 || packet.length > 16384) return;
    if (offline) {
      blocked++;
      return;
    }
    received++;
    const key = remote.address + ':' + remote.port;
    let client = clients.get(key);
    if (!client) {
      if (clients.size >= 16) return;
      client = createSocket('udp4');
      clients.set(key, client);
      client.on('error', fail);
      client.on('message', (response, from) => {
        if (from.address === '127.0.0.1' && from.port === port) {
          if (offline) {
            blocked++;
            return;
          }
          returned++;
          entry.send(response, remote.port, remote.address);
        }
      });
      client.bind(0, '127.0.0.1');
    }
    client.send(packet, port, '127.0.0.1');
  });
  entry.bind(0, '127.0.0.1');
  await once(entry, 'listening');
  return {
    configuration: {
      ...config,
      iceServers: [
        { ...server, urls: 'turn:127.0.0.1:' + entry.address().port + '?transport=udp' },
      ],
    },
    setOffline: (value) => {
      offline = value;
    },
    inspect: () => ({ clients: clients.size, received, returned, blocked, errors }),
    close: () =>
      Promise.all(
        [...clients.values(), entry].map(
          (socket) => new Promise((resolve) => socket.close(resolve)),
        ),
      ),
  };
}
