import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { SignalResponse } from '@livekit/protocol';
import { SESSION_COOKIE } from '../auth/service.js';
import type { VoiceService } from './service.js';
// Real LiveKit bearer tokens never reach the renderer, including refreshed tokens.
export function sanitizeSignal(data: RawData, binary: boolean): Uint8Array | string {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  const signal = binary
    ? SignalResponse.fromBinary(bytes)
    : SignalResponse.fromJsonString(bytes.toString());
  if (signal.message.case === 'refreshToken') signal.message.value = 'opaque-session';
  return binary ? signal.toBinary() : signal.toJsonString();
}
export function registerGateway(app: FastifyInstance, voice: VoiceService, origins: string[]) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 262144,
    perMessageDeflate: false,
  });
  app.server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (!url.pathname.startsWith('/media/')) {
      if (!url.pathname.startsWith('/socket.io/')) socket.destroy();
      return;
    }
    void (async () => {
      try {
        if (
          !origins.includes(req.headers.origin ?? '') ||
          !['/media/rtc', '/media/rtc/v1'].includes(url.pathname) ||
          url.search.length > 32768
        )
          throw new Error('Denied');
        const token = app.parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE] ?? '';
        const credential = url.searchParams.get('access_token') ?? '';
        await voice.exclusive(async () => {
          const lease = await voice.authorize(token, credential);
          const upstream = new URL(voice.config.url);
          upstream.protocol = 'ws:';
          upstream.pathname = url.pathname.replace('/media', '');
          upstream.search = url.search;
          upstream.searchParams.set('access_token', await voice.jwt(lease));
          // SDK metadata is forwarded, but credentials/room/identity are generated only by this backend.
          server.handleUpgrade(req, socket, head, (client) => {
            const remote = new WebSocket(upstream, {
              handshakeTimeout: 5000,
              maxPayload: 262144,
              perMessageDeflate: false,
            });
            const close = () => {
              client.terminate();
              remote.terminate();
            };
            lease.close?.();
            lease.close = close;
            let count = 0,
              bytes = 0,
              windowStart = Date.now();
            const pending: { data: RawData; binary: boolean }[] = [];
            client.on('message', (data, binary) => {
              if (Date.now() - windowStart > 1000) {
                count = 0;
                bytes = 0;
                windowStart = Date.now();
              }
              bytes += Buffer.byteLength(data as Buffer);
              if (
                ++count > 100 ||
                bytes > 1048576 ||
                lease.revoked ||
                remote.bufferedAmount > 1048576
              ) {
                close();
                return;
              }
              if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary });
              else if (pending.length < 20) pending.push({ data, binary });
              else close();
            });
            remote.on('open', () => {
              for (const message of pending) remote.send(message.data, { binary: message.binary });
              pending.length = 0;
            });
            remote.on('message', (data, binary) => {
              try {
                // Keep the original opaque credential through automatic SDK refresh/reconnect.
                const safe = sanitizeSignal(data, binary);
                const signal = binary
                  ? SignalResponse.fromBinary(safe as Uint8Array)
                  : SignalResponse.fromJsonString(safe as string);
                if (signal.message.case === 'refreshToken') signal.message.value = lease.id;
                if (client.bufferedAmount > 1048576) {
                  close();
                  return;
                }
                if (client.readyState === WebSocket.OPEN)
                  client.send(binary ? signal.toBinary() : signal.toJsonString(), { binary });
              } catch {
                close();
              }
            });
            client.on('error', close);
            remote.on('error', close);
            client.on('close', () => remote.terminate());
            remote.on('close', () => client.close());
          });
        });
      } catch {
        if (!socket.destroyed) socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      }
    })();
  });
  app.get('/media/rtc/validate', { logLevel: 'silent' }, async (_req, reply) =>
    reply.code(401).send('Voice authorization required.'),
  );
  app.get('/media/rtc/v1/validate', { logLevel: 'silent' }, async (_req, reply) =>
    reply.code(401).send('Voice authorization required.'),
  );
  app.addHook('preClose', async () => {
    for (const client of server.clients) client.terminate();
    server.close();
  });
}
