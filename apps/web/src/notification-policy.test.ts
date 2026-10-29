import { it, expect } from 'vitest';
import { mentionsUser, type MessageNotice } from '@tricord/shared';
import { shouldNotify, notificationBody } from './notification-policy';
const notice: MessageNotice = {
  conversationId: 'room',
  messageId: 'message',
  seq: '1',
  authorId: 'friend',
  kind: 'channel',
  mention: true,
};
it('matches case-insensitive complete mentions, not email addresses or username prefixes', () => {
  for (const body of ['@bane!', 'Hi @BANE', '(@bane)', '@other @bane'])
    expect(mentionsUser(body, 'bane')).toBe(true);
  for (const body of ['email@bane.com', '@banefriend', '@@bane', '@bane_2', 'bane'])
    expect(mentionsUser(body, 'bane')).toBe(false);
  expect(mentionsUser('@anything', '.*')).toBe(false);
});
it('alerts for private messages and mentions away from the focused conversation', () => {
  expect(shouldNotify(notice, 'me', 'other', true)).toBe(true);
  expect(shouldNotify(notice, 'me', 'room', false)).toBe(true);
  expect(shouldNotify(notice, 'me', 'room', true)).toBe(false);
  expect(shouldNotify({ ...notice, mention: false }, 'me', 'other', true)).toBe(false);
  expect(shouldNotify({ ...notice, mention: false, kind: 'dm' }, 'me', 'other', true)).toBe(true);
  expect(shouldNotify({ ...notice, mention: false, kind: 'group' }, 'me', 'other', true)).toBe(
    true,
  );
  expect(shouldNotify({ ...notice, authorId: 'me' }, 'me', null, false)).toBe(false);
});
it('notification previews contain no message or participant content', () => {
  expect(notificationBody(true)).toBe('You were mentioned. Open Rajcord to read it.');
  expect(notificationBody(false)).toBe('New private message. Open Rajcord to read it.');
});
