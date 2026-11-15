import { expect, it } from 'vitest';
import {
  attemptFor,
  authorAccent,
  DraftStore,
  sendPayload,
  isConversationAccessError,
  isReplyTargetGone,
  nearLatest,
  mentionSuggestions,
} from './chat-state';
it('offers approved self and other members for empty/canonical mention prefixes without offering unavailable users', () => {
  const self = { id: 'me', username: 'pleska', displayName: 'Me', status: 'approved' as const };
  const friend = { ...self, id: 'friend', username: 'plesk_friend', displayName: 'Friend' };
  expect(mentionSuggestions([self, friend], '')).toEqual([self, friend]);
  expect(mentionSuggestions([self, friend], 'PLESKA')).toEqual([self]);
  expect(mentionSuggestions([self, { ...friend, status: 'suspended' }], 'plesk')).toEqual([self]);
  expect(
    mentionSuggestions(
      Array.from({ length: 20 }, (_, i) => ({ ...friend, id: String(i) })),
      '',
    ),
  ).toHaveLength(10);
});
it('retains the send identity across conversation remounts but not changed reply targets', () => {
  const first = attemptFor({ body: 'hello', replyToId: 'root', attempt: null }, () => 'first');
  expect(attemptFor({ body: 'hello', replyToId: 'root', attempt: first }, () => 'second')).toBe(
    first,
  );
  expect(
    attemptFor({ body: 'hello', replyToId: 'other', attempt: first }, () => 'second').clientId,
  ).toBe('second');
  expect(
    attemptFor({ body: 'edited', replyToId: 'root', attempt: first }, () => 'third').clientId,
  ).toBe('third');
});
it('omits unsupported null reply fields for legacy server basic sends', () => {
  expect(sendPayload({ clientId: 'id', body: 'text', replyToId: null })).toEqual({
    clientId: 'id',
    body: 'text',
  });
  expect(sendPayload({ clientId: 'id', body: 'text', replyToId: 'root' })).toEqual({
    clientId: 'id',
    body: 'text',
    replyToId: 'root',
  });
});
it('notifies a reopened composer when an earlier send completes, without persistent storage', () => {
  const store = new DraftStore();
  store.set('conversation', { body: 'pending', replyToId: null, attempt: null });
  let notifications = 0;
  const unsubscribe = store.subscribe('conversation', () => notifications++);
  store.delete('conversation');
  expect(notifications).toBe(1);
  expect(store.get('conversation')).toBeUndefined();
  unsubscribe();
  store.set('conversation', { body: 'new draft', replyToId: null, attempt: null });
  expect(notifications).toBe(1);
});
it('retains independent GIF retry identities across conversation switches and clears them with access/logout', () => {
  const store = new DraftStore();
  const attempt = { clientId: 'gif-id', body: 'https://media.tenor.com/test.gif', replyToId: null };
  store.mediaAttempts.set('conversation', attempt);
  store.set('conversation', { body: 'Unsent text', replyToId: null, attempt: null });
  store.delete('conversation');
  expect(store.mediaAttempts.get('conversation')).toBe(attempt);
  store.forget('conversation');
  expect(store.mediaAttempts.size).toBe(0);
  store.mediaAttempts.set('another', attempt);
  store.clear();
  expect(store.mediaAttempts.size).toBe(0);
});
it('distinguishes lost access from transient failures before clearing private views and drafts', () => {
  for (const status of [401, 403, 404])
    expect(isConversationAccessError(Object.assign(new Error('Denied'), { status }))).toBe(true);
  for (const status of [400, 409, 429, 500, 503])
    expect(isConversationAccessError(Object.assign(new Error('Retry'), { status }))).toBe(false);
  expect(isConversationAccessError(new TypeError('Network unavailable'))).toBe(false);
});
it('clears a retained reply target only when it is definitively unavailable', () => {
  for (const status of [403, 404])
    expect(isReplyTargetGone(Object.assign(new Error('Gone'), { status }))).toBe(true);
  for (const status of [401, 408, 429, 500, 502, 503])
    expect(isReplyTargetGone(Object.assign(new Error('Retry'), { status }))).toBe(false);
  expect(isReplyTargetGone(new TypeError('Network unavailable'))).toBe(false);
});
it('rechecks actual geometry when media or viewport resizing moves latest content out of view', () => {
  expect(nearLatest({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true);
  expect(nearLatest({ scrollHeight: 1000, scrollTop: 500, clientHeight: 250 })).toBe(false);
  expect(nearLatest({ scrollHeight: 2000, scrollTop: 500, clientHeight: 500 })).toBe(false);
  expect(nearLatest({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 })).toBe(true);
  expect(nearLatest({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })).toBe(false);
});
it('derives identity accents stably from account IDs, not display names or status', () => {
  expect(authorAccent('account')).toBe(authorAccent('account'));
  expect(authorAccent('account')).toMatch(/^#[a-f0-9]{6}$/);
});
