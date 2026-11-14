import { expect, it } from 'vitest';
import { invalidClientSocketAck, validateClientSocketPacket } from './socket-contracts.js';

const ack = () => {};

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
