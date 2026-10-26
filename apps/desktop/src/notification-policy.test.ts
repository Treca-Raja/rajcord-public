import { it, expect } from 'vitest';
import { validNotice, trustedNoticeFrame } from './notification-policy.js';
const id = '4e4b4a40-6937-4e01-bff2-6c30254180bd';
it('accepts only a conversation identifier and a mention flag', () => {
  expect(validNotice({ conversationId: id, mention: true })).toBe(true);
  for (const value of [
    null,
    {},
    { conversationId: 'https://evil.test', mention: false },
    { conversationId: id, mention: 'yes' },
    { conversationId: id, mention: true, body: 'secret' },
  ])
    expect(validNotice(value)).toBe(false);
});
it('rejects notification IPC from foreign origins and child frames', () => {
  expect(trustedNoticeFrame('https://127.0.0.1', 'https://127.0.0.1/', true)).toBe(true);
  expect(trustedNoticeFrame('https://tricord.test', 'https://evil.test', true)).toBe(false);
  expect(trustedNoticeFrame('https://tricord.test', 'https://tricord.test', false)).toBe(false);
  expect(trustedNoticeFrame('https://tricord.test', 'broken', true)).toBe(false);
});
