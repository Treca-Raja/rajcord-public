import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@tricord/shared';
import { MessageCard } from './MessageCard';

function message(id: string, username: string): ChatMessage {
  return {
    featureVersion: 2,
    id,
    conversationId: 'conversation',
    clientId: id,
    seq: '1',
    change: '1',
    contextChange: '1',
    author: { id, username, displayName: 'Same display name' },
    body: 'Plain text',
    createdAt: '2026-10-30T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    replyTo: null,
    threadRoot: null,
    replyCount: 0,
    pinned: false,
    reactions: [],
    mentions: [],
  };
}
const actions = {
  userId: 'second',
  canPin: true,
  archived: false,
  onReply: () => {},
  onThread: () => {},
  onJump: () => {},
  onUpdate: async () => {},
};
it('distinguishes duplicate display names with usernames and You, not color or role claims', () => {
  const html = [message('first', 'first_user'), message('second', 'second_user')]
    .map((item) => renderToStaticMarkup(createElement(MessageCard, { item, ...actions })))
    .join('');
  expect(html).toContain('@first_user');
  expect(html).toContain('@second_user');
  expect(html.match(/<small>You<\/small>/g)).toHaveLength(1);
  expect(html).not.toContain('role="menu"');
  expect(html.match(/aria-label="More message actions"/g)).toHaveLength(2);
  expect(html).not.toContain('administrator');
  expect(html).not.toContain('Online');
  expect(html).toContain('aria-label="Reply"');
  for (const action of ['Edit message', 'Delete message', 'Pin message', 'Add reaction'])
    expect(html).not.toContain('>' + action + '<');
});
it('escapes author names and never renders a deleted ancestor quote or unauthorized original ID', () => {
  const item = message('first', 'first_user');
  item.author.displayName = '<img src=x onerror=alert(1)>';
  item.replyTo = { available: false };
  const html = renderToStaticMarkup(createElement(MessageCard, { item, ...actions }));
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
  expect(html).toContain('Original unavailable');
  expect(html).not.toContain('Jump to original from');
});
it('keeps reactions beneath and outside the message highlight while retaining a sender on grouped messages', () => {
  const item = message('first', 'first_user');
  item.reactions = [{ emoji: '👍🏽', count: 2, mine: false }];
  const html = renderToStaticMarkup(
    createElement(MessageCard, { item, grouped: true, ...actions }),
  );
  expect(html).toContain('Same display name');
  expect(html).toContain('@first_user');
  expect(html.indexOf('class="chat-message-reactions"')).toBeGreaterThan(
    html.indexOf('</article>'),
  );
  expect(html).toContain('aria-label="Reactions to message from first_user"');
});
it('marks opened originals and reply targets independently, and makes quotes navigation buttons', () => {
  const item = message('reply', 'first_user');
  item.replyTo = {
    available: true,
    id: 'original',
    seq: '1',
    change: '1',
    author: item.author,
    body: 'Original text',
    deleted: false,
  };
  const html = renderToStaticMarkup(
    createElement(MessageCard, { item, highlighted: true, replyTarget: true, ...actions }),
  );
  expect(html).toContain('data-highlighted="true"');
  expect(html).toContain('data-reply-target="true"');
  expect(html).toContain('<button type="button" class="reply-quote"');
  expect(html).toContain('Jump to original from first_user');
  expect(html).toContain('Original text');
});
