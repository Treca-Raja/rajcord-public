import { it, expect } from 'vitest';
import { mergeMessages } from './message-state';
import type { ChatMessage } from '@tricord/shared';
function m(id: string, seq: string, change: string, body: string | null = 'text'): ChatMessage {
  return {
    id,
    seq,
    change,
    body,
    deleted: body === null,
    conversationId: 'c',
    clientId: id,
    author: { id: 'a', username: 'a', displayName: 'A' },
    createdAt: '2026-01-01',
    editedAt: null,
  };
}
it('deduplicates ack/realtime/history and preserves edits against stale responses', () => {
  const original = m('a', '1', '1'),
    edited = m('a', '1', '3', 'edited');
  expect(mergeMessages([original], [edited, original])).toEqual([edited]);
});
it('does not resurrect a tombstone from delayed history and sorts bigint ordering accurately', () => {
  const deleted = m('a', '9007199254740993', '4', null),
    next = m('b', '9007199254740994', '5');
  expect(mergeMessages([next, deleted], [m('a', '9007199254740993', '1')])).toEqual([
    deleted,
    next,
  ]);
});
