import { it, expect } from 'vitest';
import { mentionsUser, type MessageNotice } from '@tricord/shared';
import {
  shouldNotify,
  notificationBody,
  notificationTarget,
  notificationOutputs,
  deviceNotifications,
  defaultDeviceNotifications,
  inAppNotice,
  readDeviceNotifications,
} from './notification-policy';
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
  expect(notificationBody(true)).toBe('New activity. Open Rajcord to read it.');
  expect(notificationBody(false)).toBe(notificationBody(true));
  expect(inAppNotice(notice, false)).toBe('New activity in Rajcord');
  expect(inAppNotice(notice, true)).toBe('You were mentioned');
});
it('honors explicit account rules and immediate replies, with mutes stronger than priority', () => {
  const configured: MessageNotice = {
    ...notice,
    mention: false,
    preferences: { mode: 'mentions', senderMuted: false, priority: false },
  };
  expect(shouldNotify(configured, 'me', null, false)).toBe(false);
  expect(shouldNotify({ ...configured, reply: true }, 'me', null, false)).toBe(true);
  expect(
    shouldNotify(
      { ...configured, preferences: { ...configured.preferences!, priority: true } },
      'me',
      null,
      false,
    ),
  ).toBe(true);
  for (const preferences of [
    { mode: 'muted', senderMuted: false, priority: true },
    { mode: 'all', senderMuted: true, priority: true },
  ] as const)
    expect(
      shouldNotify({ ...configured, mention: true, reply: true, preferences }, 'me', null, false),
    ).toBe(false);
  expect(
    shouldNotify(
      { ...configured, preferences: { mode: 'all', senderMuted: false, priority: false } },
      'me',
      null,
      false,
    ),
  ).toBe(true);
});
it('defaults to no outputs and keeps popup denial independent of sound and in-app alerts', () => {
  expect(deviceNotifications(null)).toEqual(defaultDeviceNotifications);
  expect(deviceNotifications('on')).toEqual(defaultDeviceNotifications);
  expect(
    readDeviceNotifications(
      { getItem: (key) => (key.startsWith('tricord-notifications:') ? 'on' : null) },
      'account',
    ),
  ).toEqual({ ...defaultDeviceNotifications, enabled: true, popup: true });
  expect(deviceNotifications('{bad')).toEqual(defaultDeviceNotifications);
  expect(deviceNotifications('{"sound":"true","volume":8}')).toMatchObject({
    sound: false,
    volume: 1,
  });
  const enabled = { ...defaultDeviceNotifications, enabled: true };
  for (const popup of [true, false])
    for (const sound of [true, false]) {
      expect(notificationOutputs({ ...enabled, popup, sound }, false, false)).toEqual({
        popup: popup ? 'toast' : 'none',
        sound,
      });
      expect(
        notificationOutputs({ ...enabled, popup, sound, enabled: false }, false, true),
      ).toEqual({ popup: 'none', sound: false });
    }
  expect(notificationOutputs({ ...enabled, popup: true, sound: true }, false, true)).toEqual({
    popup: 'os',
    sound: true,
  });
  expect(notificationOutputs({ ...enabled, popup: true }, true, true).popup).toBe('toast');
});
it('accepts only inert message targets; later navigation still reauthorizes', () => {
  const id = '4e4b4a40-6937-4e01-bff2-6c30254180bd';
  expect(notificationTarget(id)).toEqual({ conversationId: id });
  expect(notificationTarget({ conversationId: id, messageId: id, thread: true })).toEqual({
    conversationId: id,
    messageId: id,
    thread: true,
  });
  for (const value of [
    'https://evil.test',
    { conversationId: id, messageId: 'url' },
    { conversationId: id, thread: true },
    { conversationId: id, body: 'private' },
    { conversationId: id, thread: 'true' },
  ])
    expect(notificationTarget(value)).toBeNull();
});
