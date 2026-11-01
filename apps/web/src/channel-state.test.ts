import { expect, it } from 'vitest';
import type { ChannelCategory, Conversation } from '@tricord/shared';
import { channelCategories, channelFields } from './channel-state';

it('merges referenced and paginated categories by revision and shared order', () => {
  const first: ChannelCategory = { id: 'a', name: 'First', position: 0, revision: '2' };
  const later: ChannelCategory = { id: 'b', name: 'Later', position: 10, revision: '0' };
  const conversation: Conversation = {
    id: 'channel',
    kind: 'channel',
    name: 'Readable channel',
    archived: false,
    topic: '',
    category: first,
    position: 0,
    metadataRevision: '0',
    unreadCount: 0,
    mentionCount: 0,
    lastReadSeq: '0',
    activity: '0',
    managerId: null,
    members: [],
  };
  expect(
    channelCategories([conversation], [later, { ...first, name: 'Stale', revision: '1' }]),
  ).toEqual([first, later]);
  expect(
    channelCategories([conversation], [{ ...first, name: 'New', revision: '3' }])[0]?.name,
  ).toBe('New');
});

it('reads channel forms without persisting drafts or coercing category IDs', () => {
  const data = new FormData();
  data.set('name', 'Game night 🎮');
  data.set('topic', 'Meet here');
  data.set('categoryId', '');
  data.set('position', '12');
  expect(channelFields(data)).toEqual({
    name: 'Game night 🎮',
    topic: 'Meet here',
    categoryId: null,
    position: 12,
  });
});
