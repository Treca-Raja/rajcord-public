import { expect, it } from 'vitest';
import { invalidClientSocketAck, validateClientSocketPacket } from './socket-contracts.js';

const ack = () => {};

it('validates bounded multi-view selection fields before screen authorization', () => {
  const request = {
    epoch: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    shareId: '00000000-0000-4000-8000-000000000003',
    profile: 'smooth',
    videoBitrate: 4000000,
    resolution: 1080,
    frameRate: 60,
  };
  for (const mode of ['replace', 'add'])
    expect(validateClientSocketPacket('screen:select', [{ ...request, mode }, ack])).toBe(true);
  expect(
    validateClientSocketPacket('screen:select', [{ ...request, videoBitrate: 17000000 }, ack]),
  ).toBe(true);
  expect(
    validateClientSocketPacket('screen:select', [{ ...request, videoBitrate: 17000001 }, ack]),
  ).toBe(false);
  expect(
    validateClientSocketPacket('screen:select', [
      {
        ...request,
        shareId: null,
        mode: 'remove',
        removeShareId: request.shareId,
      },
      ack,
    ]),
  ).toBe(true);
  expect(validateClientSocketPacket('screen:select', [{ ...request, mode: 'all' }, ack])).toBe(
    false,
  );
  expect(
    validateClientSocketPacket('screen:select', [
      {
        ...request,
        shareId: null,
        mode: 'remove',
        removeShareId: 'invalid',
      },
      ack,
    ]),
  ).toBe(false);
  expect(validateClientSocketPacket('screen:select', [{ ...request, bypass: true }, ack])).toBe(
    false,
  );
});

it('accepts only declared client packets with the expected payload and acknowledgment', () => {
  expect(
    validateClientSocketPacket('message:send', [
      {
        conversationId: '00000000-0000-4000-8000-000000000001',
        clientId: '00000000-0000-4000-8000-000000000002',
        body: 'hello',
      },
      ack,
    ]),
  ).toBe(true);
  expect(validateClientSocketPacket('connection:ping', [ack])).toBe(true);
  expect(
    validateClientSocketPacket('message:send', [
      { conversationId: 'not-an-id', clientId: 'attempt', body: 'hello' },
      ack,
    ]),
  ).toBe(false);
  expect(validateClientSocketPacket('message:send', [{}, ack, 'unexpected'])).toBe(false);
  expect(validateClientSocketPacket('connection:ping', [])).toBe(false);
  expect(validateClientSocketPacket('__proto__', [ack])).toBe(false);
});

it('returns fixed safe acknowledgments for rejected client packets', () => {
  expect(invalidClientSocketAck('message:send')).toEqual({
    ok: false,
    status: 400,
    error: 'Invalid socket request.',
  });
  expect(invalidClientSocketAck('screen:publish')).toEqual({
    ok: false,
    code: 'invalid',
    error: 'Invalid screen request.',
  });
  expect(invalidClientSocketAck('connection:ping')).toEqual({ ok: false });
});
