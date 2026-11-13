import { it, expect } from 'vitest';
import { compatibleMessage, mergeMessages } from './message-state';
import type { ChatMessage } from '@tricord/shared';
function m(id: string, seq: string, change: string, body: string | null = 'text'): ChatMessage {
  return {
    featureVersion: 2,
    id,
    seq,
    change,
    contextChange: change,
    body,
    deleted: body === null,
    conversationId: 'c',
    clientId: id,
    author: { id: 'a', username: 'a', displayName: 'A' },
    createdAt: '2026-01-01',
    editedAt: null,
    replyTo: null,
    threadRoot: null,
    replyCount: 0,
    pinned: false,
    reactions: [],
    mentions: [],
  };
}
it('deduplicates ack/realtime/history and preserves edits against stale responses', () => {
  const original = m('a', '1', '1'),
    edited = m('a', '1', '3', 'edited');
  expect(mergeMessages([original], [edited, original])).toEqual([edited]);
});
it('keeps known legacy text readable while explicitly marking enhanced features unavailable', () => {
  const legacy = {
    id: 'legacy',
    conversationId: 'c',
    clientId: 'id',
    seq: '1',
    change: '1',
    author: { id: 'a', username: 'a', displayName: 'A' },
    body: 'Legacy text',
    createdAt: '2026-01-01',
    editedAt: null,
    deleted: false,
  };
  expect(compatibleMessage(legacy)).toMatchObject({
    featureVersion: 1,
    body: 'Legacy text',
    replyTo: null,
    pinned: false,
    reactions: [],
    mentions: [],
  });
});
it('does not resurrect a tombstone from delayed history and sorts bigint ordering accurately', () => {
  const deleted = m('a', '9007199254740993', '4', null),
    next = m('b', '9007199254740994', '5');
  expect(mergeMessages([next, deleted], [m('a', '9007199254740993', '1')])).toEqual([
    deleted,
    next,
  ]);
});
it('refreshes dependent quotes and thread counts without inserting off-window messages', () => {
  const root = m('root', '1', '1');
  const reply = {
    ...m('reply', '2', '2'),
    threadRoot: {
      available: true as const,
      id: root.id,
      seq: root.seq,
      change: root.change,
      author: root.author,
      body: root.body,
      deleted: false,
    },
    replyTo: {
      available: true as const,
      id: root.id,
      seq: root.seq,
      change: root.change,
      author: root.author,
      body: root.body,
      deleted: false,
    },
    replyCount: 1,
  };
  const deleted = { ...m('root', '1', '4', null), contextChange: '4', replyCount: 1 };
  const merged = mergeMessages([reply], [deleted], false);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.replyTo).toMatchObject({ deleted: true, body: null });
  expect(merged[0]?.threadRoot).toMatchObject({ deleted: true, body: null });
  expect(merged[0]?.contextChange).toBe('4');
  const latest = { ...root, contextChange: '5', replyCount: 3 };
  expect(
    mergeMessages([latest], [{ ...root, contextChange: '2', replyCount: 1 }])[0]?.replyCount,
  ).toBe(3);
});
