import { expect, it } from 'vitest';
import { needsNotificationPrompt } from './notification-policy';

it('invites first-time users without prompting again after a choice or existing alert settings', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  expect(needsNotificationPrompt(storage, 'account')).toBe(true);
  for (const key of [
    'tricord-notification-prompt:',
    'tricord-notification-device-v2:',
    'tricord-notifications:',
  ]) {
    values.set(key + 'account', 'saved');
    expect(needsNotificationPrompt(storage, 'account')).toBe(false);
    expect(needsNotificationPrompt(storage, 'other')).toBe(true);
    values.clear();
  }
});
