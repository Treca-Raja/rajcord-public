import { it, expect } from 'vitest';
import {
  validNotice,
  validNativeNotice,
  trustedNoticeFrame,
  canCoalesceNativeNotice,
  nativeNotificationResponse,
} from './notification-policy.js';
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
it('negotiates strict versioned targets without allowing private content or executable URLs', () => {
  const notice = {
    version: 2,
    target: { conversationId: id, messageId: id, thread: true },
    mention: true,
  };
  expect(validNativeNotice(notice)).toBe(true);
  expect(validNotice(notice)).toBe(false);
  for (const value of [
    { ...notice, version: 1 },
    { ...notice, body: 'secret' },
    { ...notice, target: { ...notice.target, author: 'secret' } },
    { ...notice, target: { conversationId: 'https://evil.test' } },
    { ...notice, target: { conversationId: id, thread: true } },
  ])
    expect(validNativeNotice(value)).toBe(false);
});
it('coalesces only a live bounded burst, not closed or old notifications', () => {
  expect(canCoalesceNativeNotice(undefined, 4000)).toBe(false);
  expect(canCoalesceNativeNotice({ at: 1000, active: true }, 3999)).toBe(true);
  expect(canCoalesceNativeNotice({ at: 1000, active: true }, 4000)).toBe(false);
  expect(canCoalesceNativeNotice({ at: 1000, active: false }, 1100)).toBe(false);
  expect(canCoalesceNativeNotice({ at: 1000, active: true }, 999)).toBe(false);
  expect(nativeNotificationResponse(true, { status: 'coalesced', count: 3 })).toEqual({
    status: 'coalesced',
    count: 3,
  });
  expect(nativeNotificationResponse(false, { status: 'coalesced', count: 3 })).toBe(false);
  expect(nativeNotificationResponse(false, { status: 'shown' })).toBe(true);
  expect(nativeNotificationResponse(false, { status: 'unavailable' })).toBe(false);
});
it('rejects notification IPC from foreign origins and child frames', () => {
  expect(trustedNoticeFrame('https://127.0.0.1', 'https://127.0.0.1/', true)).toBe(true);
  expect(trustedNoticeFrame('https://tricord.test', 'https://evil.test', true)).toBe(false);
  expect(trustedNoticeFrame('https://tricord.test', 'https://tricord.test', false)).toBe(false);
  expect(trustedNoticeFrame('https://tricord.test', 'broken', true)).toBe(false);
});
