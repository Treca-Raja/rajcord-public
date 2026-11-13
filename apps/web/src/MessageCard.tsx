import { memo, useCallback, useRef, useState } from 'react';
import { MoreHorizontal, Reply, Pin, Pencil } from 'lucide-react';
import type { ChatMessage, MessageReference, ChannelReference } from '@tricord/shared';
import { Avatar } from '@tricord/ui';
import { MessageBody } from './MessageBody';
import { GifPreviews } from './GifPreviews';
import { MessageMenu, type MessageMenuAction } from './MessageMenu';
import { authorAccent } from './chat-state';
import './messages.css';
import { EmojiGlyph, EmojiText } from './EmojiText';

export function ReplyReference({
  reference,
  onJump,
}: {
  reference: MessageReference;
  onJump: (id: string) => void;
}) {
  if (!reference.available) return <p className="reply-quote">Original unavailable</p>;
  if (reference.deleted) return <p className="reply-quote">Original deleted</p>;
  return (
    <button
      type="button"
      className="reply-quote"
      onClick={() => onJump(reference.id)}
      aria-label={'Jump to original from ' + reference.author.username}
    >
      <Reply size={12} aria-hidden="true" />
      <strong>@{reference.author.username}</strong>
      <span className="reply-preview-text">{reference.body}</span>
    </button>
  );
}
export const MessageCard = memo(function MessageCard({
  item,
  userId,
  canPin,
  archived,
  grouped = false,
  highlighted = false,
  replyTarget = false,
  onReply,
  onThread,
  onJump,
  onUpdate,
  channels = [],
  onChannel,
}: {
  item: ChatMessage;
  userId: string;
  canPin: boolean;
  archived: boolean;
  grouped?: boolean;
  highlighted?: boolean;
  replyTarget?: boolean;
  onReply: (item: ChatMessage) => void;
  onThread: (item: ChatMessage) => void;
  onJump: (id: string) => void;
  onUpdate: (
    item: ChatMessage,
    action: 'edit' | 'delete' | 'pin' | 'unpin' | 'react' | 'unreact',
    body?: string,
  ) => Promise<void>;
  channels?: ChannelReference[];
  onChannel?: (channel: ChannelReference) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const article = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [error, setError] = useState('');
  async function update(action: Parameters<typeof onUpdate>[1], value?: string) {
    setBusy(true);
    setError('');
    try {
      await onUpdate(item, action, value);
      setEditing(false);
      if (action === 'edit' || action === 'delete') article.current?.focus({ preventScroll: true });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (item.deleted) return <p className="deleted-message">Original deleted</p>;
  const actions: MessageMenuAction[] = [];
  if (item.featureVersion === 2) {
    actions.push(
      { label: 'Reply', disabled: archived || busy, run: () => onReply(item) },
      {
        label: 'Open thread' + (item.replyCount ? ' (' + item.replyCount + ')' : ''),
        run: () => onThread(item),
      },
    );
    if (canPin)
      actions.push({
        label: item.pinned ? 'Unpin message' : 'Pin message',
        disabled: archived || busy,
        run: () => void update(item.pinned ? 'unpin' : 'pin'),
      });
  }
  if (item.author.id === userId)
    actions.push(
      {
        label: 'Edit message',
        disabled: busy,
        run: () => {
          setText(item.body ?? '');
          setEditing(true);
        },
      },
      {
        label: 'Delete message',
        disabled: busy,
        danger: true,
        run: () => {
          if (window.confirm('Delete this message permanently?')) void update('delete');
        },
      },
    );
  return (
    <div className="chat-message-entry" data-message-entry-id={item.id}>
      <article
        ref={article}
        className={
          'chat-message-row' +
          (grouped ? ' consecutive-message' : '') +
          (item.mentions.some((user) => user.id === userId) ? ' mentions-you' : '')
        }
        data-message-id={item.id}
        data-highlighted={highlighted}
        data-reply-target={replyTarget}
        tabIndex={0}
        aria-label={'Message from ' + item.author.displayName + ' @' + item.author.username}
        onContextMenu={(event) => {
          if (event.target instanceof Element && event.target.closest('a,textarea,input')) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
          )
            return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu({ x: bounds.right - 220, y: bounds.top + 28 });
        }}
      >
        <span
          className="chat-message-avatar"
          style={{ borderColor: authorAccent(item.author.id) }}
          aria-hidden="true"
        >
          <Avatar>{[...item.author.displayName][0] ?? '?'}</Avatar>
        </span>
        <div className="chat-message-author">
          <div className="chat-author-name">
            <strong title={item.author.displayName}>
              <EmojiText text={item.author.displayName} />
            </strong>
            {item.author.id === userId && <small>You</small>}
          </div>
          <span title={'@' + item.author.username}>@{item.author.username}</span>
        </div>
        <div className="chat-message-content">
          {item.replyTo && <ReplyReference reference={item.replyTo} onJump={onJump} />}
          {editing ? (
            <form
              className="edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                void update('edit', text);
              }}
            >
              <textarea
                aria-label="Edit message"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={4000}
                required
                disabled={busy}
                autoFocus
              />
              <button className="primary" disabled={busy}>
                Save
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <MessageBody
                body={item.body ?? ''}
                channels={channels}
                onChannel={onChannel}
                mentions={
                  item.author.id === userId
                    ? [...item.mentions, { username: item.author.username }]
                    : item.mentions
                }
              />
              <GifPreviews body={item.body ?? ''} />
            </>
          )}
          {!editing && actions.length > 0 && (
            <div className="message-hover-actions">
              {item.featureVersion === 2 && (
                <button
                  type="button"
                  title="Reply"
                  aria-label="Reply"
                  disabled={archived || busy}
                  onClick={() => onReply(item)}
                >
                  <Reply size={17} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                title="Message actions"
                aria-label="More message actions"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: bounds.right - 210, y: bounds.bottom + 5 });
                }}
              >
                <MoreHorizontal size={19} aria-hidden="true" />
              </button>
            </div>
          )}
          {menu && (
            <MessageMenu
              point={menu}
              anchor={article}
              actions={actions}
              canReact={item.featureVersion === 2 && !archived && !busy}
              onClose={closeMenu}
              onReact={(emoji) => void update('react', emoji)}
            />
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="chat-message-information">
          <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
            {new Date(item.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {item.pinned && (
            <span className="chat-message-flag" title="Pinned">
              <Pin size={11} aria-hidden="true" />
              <span className="sr-only">Pinned</span>
            </span>
          )}
          {item.editedAt && (
            <span className="chat-message-flag" title="Edited">
              <Pencil size={11} aria-hidden="true" />
              <span className="sr-only">edited</span>
            </span>
          )}
        </div>
      </article>
      {item.reactions.length > 0 && (
        <div
          className="chat-message-reactions"
          aria-label={'Reactions to message from ' + item.author.username}
        >
          {item.reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              aria-pressed={reaction.mine}
              aria-label={
                reaction.emoji +
                ': ' +
                reaction.count +
                ' reactions' +
                (reaction.mine ? ', including yours' : '')
              }
              disabled={busy || archived}
              onClick={() => void update(reaction.mine ? 'unreact' : 'react', reaction.emoji)}
            >
              <EmojiGlyph emoji={reaction.emoji} /> {reaction.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
