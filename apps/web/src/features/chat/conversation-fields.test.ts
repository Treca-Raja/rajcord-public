import { expect, it } from 'vitest';
import { newConversationFields } from './conversation-fields';

it('submits a direct-message recipient without unrelated group fields', () => {
  const data = new FormData();
  data.set('userId', 'friend');
  data.set('name', 'Unused');
  data.append('userIds', 'another');
  expect(newConversationFields('dm', data)).toEqual({ kind: 'dm', userId: 'friend' });
});

it('preserves the group name and selection order for server validation', () => {
  const data = new FormData();
  data.set('name', '  Friends 🎮  ');
  for (const id of ['second', 'first', 'second']) data.append('userIds', id);
  expect(newConversationFields('group', data)).toEqual({
    kind: 'group',
    name: '  Friends 🎮  ',
    userIds: ['second', 'first', 'second'],
  });
});

it('retains missing field values so the server remains the validation authority', () => {
  expect(newConversationFields('dm', new FormData())).toEqual({ kind: 'dm', userId: null });
  expect(newConversationFields('group', new FormData())).toEqual({
    kind: 'group',
    name: null,
    userIds: [],
  });
});
