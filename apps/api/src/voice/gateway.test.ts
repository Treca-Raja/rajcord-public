import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import type { VoiceService } from './service.js';
import { registerGateway } from './gateway.js';

it('owns TCP errors while upgrade authorization is pending and never upgrades a disconnected socket', async () => {
  const server = new EventEmitter();
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const jwt = vi.fn();
  const voice = {
    exclusive: async (work: () => Promise<void>) => work(),
    authorize: async () => {
      entered();
      await gate;
      return {};
    },
    jwt,
  } as unknown as VoiceService;
  const app = {
    server,
    parseCookie: () => ({}),
    get: vi.fn(),
    addHook: vi.fn(),
  } as unknown as FastifyInstance;
  registerGateway(app, voice, ['http://127.0.0.1']);
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    end: vi.fn(),
  });
  server.emit(
    'upgrade',
    { url: '/media/rtc?access_token=fixture', headers: { origin: 'http://127.0.0.1' } },
    socket,
    Buffer.alloc(0),
  );
  await started;
  try {
    expect(() =>
      socket.emit('error', Object.assign(new Error('Fixture reset'), { code: 'ECONNRESET' })),
    ).not.toThrow();
  } finally {
    finish();
  }
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  expect(jwt).not.toHaveBeenCalled();
});
