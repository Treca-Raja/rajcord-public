import { afterEach, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { createApp } from './app.js';
const active: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const { app } of active.splice(0)) await app.close();
});
describe('foundation', () => {
  it('serves a real health response without claiming database readiness', async () => {
    const instance = createApp();
    active.push(instance);
    const response = await instance.app.inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'tricord-api', milestone: 2 });
  });
  it('does not expose unimplemented message endpoints', async () => {
    const instance = createApp();
    active.push(instance);
    expect((await instance.app.inject('/messages')).statusCode).toBe(404);
  });
  it('rejects anonymous Socket.IO connections', async () => {
    const instance = createApp();
    active.push(instance);
    const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const socket = connect(address, {
      transports: ['websocket'],
      extraHeaders: { Origin: 'http://127.0.0.1:5173' },
    });
    try {
      await new Promise<void>((resolve) => socket.once('connect_error', () => resolve()));
      expect(socket.connected).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
  it('rejects untrusted socket origins', async () => {
    const instance = createApp();
    active.push(instance);
    const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const socket = connect(address, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Origin: 'https://untrusted.example' },
    });
    try {
      await new Promise<void>((resolve) => socket.on('connect_error', () => resolve()));
      expect(socket.connected).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});
