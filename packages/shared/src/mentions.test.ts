import { expect, it } from 'vitest';
import { mentionUsernames, mentionsUser } from './index.js';

it('resolves exact ASCII usernames with Unicode-aware boundaries, never partial or email-like tokens', () => {
  for (const body of ['@bane', 'Hey @BANE!', '🎮 @bane', '(@bane)', '@bane @bane'])
    expect(mentionUsernames(body)).toEqual(['bane']);
  for (const body of ['email@bane.com', 'é@bane.test', '中@bane', '@baneé', '@@bane', '@Karl'])
    expect(mentionUsernames(body)).toEqual([]);
  for (const body of ['@banefriend', '@bane_2']) expect(mentionsUser(body, 'bane')).toBe(false);
  expect(mentionsUser('@BANE', 'bane')).toBe(true);
});
