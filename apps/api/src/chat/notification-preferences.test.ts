import { expect, it, vi } from 'vitest';
import type { ChatService } from './service.js';
import {
  conversationAlertInput,
  senderAlertInput,
  senderAlertPage,
  noticePreferences,
} from './notification-preferences.js';
const id = '4e4b4a40-6937-4e01-bff2-6c30254180bd';
it('strictly validates account alert writes and rejects ambiguous or empty input', () => {
  for (const mode of ['all', 'mentions', 'muted', null])
    expect(conversationAlertInput({ mode })).toBe(mode);
  for (const body of [null, {}, [], { mode: [] }, { mode: 'all', userId: id }, { mode: 'none' }])
    expect(() => conversationAlertInput(body)).toThrow();
  expect(senderAlertInput({ muted: false, priority: true })).toEqual({
    muted: false,
    priority: true,
  });
  expect(senderAlertInput({ priority: false })).toEqual({ priority: false });
  for (const body of [{}, { muted: 'true' }, { priority: null }, { muted: true, userId: id }])
    expect(() => senderAlertInput(body)).toThrow();
});
it('bounds sender pages and validates seek cursors instead of exposing an unbounded list', () => {
  expect(senderAlertPage({})).toEqual({ after: null, limit: 50 });
  expect(senderAlertPage({ after: id, limit: '100' })).toEqual({ after: id, limit: 100 });
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 10 },
    { limit: '01' },
    { after: 'bad' },
    { userId: id },
  ])
    expect(() => senderAlertPage(query)).toThrow();
});
it('resolves recipient-private rules only after current authorization in one transaction', async () => {
  const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({
    rows: [{ mode: null, muted: null, priority: null }],
  }));
  const access = vi.fn(async () => ({ kind: 'channel', archived: false }));
  const service = {
    run: vi.fn(async (_token: string, work: (db: unknown, user: unknown) => unknown) =>
      work({ query }, { id: 'recipient' }),
    ),
    access,
  } as unknown as ChatService;
  expect(await noticePreferences(service, 'session', id, id)).toEqual({
    mode: 'mentions',
    senderMuted: false,
    priority: false,
  });
  expect(access).toHaveBeenCalledWith({ query }, 'recipient', id);
  expect(query.mock.calls[0]?.[1]).toEqual(['recipient', id, id]);
  access.mockResolvedValue({ kind: 'dm', archived: false });
  expect((await noticePreferences(service, 'session', id, id)).mode).toBe('all');
  access.mockRejectedValueOnce(new Error('Membership revoked'));
  query.mockClear();
  await expect(noticePreferences(service, 'session', id, id)).rejects.toThrow('Membership revoked');
  expect(query).not.toHaveBeenCalled();
});
it('fails closed for archived conversations without letting priority undo mute', async () => {
  const service = {
    run: async (_token: string, work: (db: unknown, user: unknown) => unknown) =>
      work(
        { query: async () => ({ rows: [{ mode: 'all', muted: true, priority: true }] }) },
        { id },
      ),
    access: async () => ({ kind: 'channel', archived: true }),
  } as unknown as ChatService;
  expect(await noticePreferences(service, 'session', id, id)).toEqual({
    mode: 'muted',
    senderMuted: true,
    priority: true,
  });
});
