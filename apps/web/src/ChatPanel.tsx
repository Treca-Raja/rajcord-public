import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  Conversation,
  PinnedPage,
  ThreadPage,
  ChannelReference,
} from '@tricord/shared';
import { Pin, MessageSquare, RefreshCw, X, ArrowUpRight } from 'lucide-react';
import { useAuth } from './Auth';
import { MessageCard } from './MessageCard';

export type OpenChatPanel = { kind: 'pins' } | { kind: 'thread'; anchorId: string };
export const ChatPanel = memo(function ChatPanel({
  panel,
  open,
  conversation,
  onClose,
  onReply,
  onJump,
  onThread,
  onUpdate,
  channels,
  onChannel,
  replyTargetId = null,
}: {
  panel: OpenChatPanel;
  open: boolean;
  conversation: Conversation;
  onClose: () => void;
  onReply: (item: ChatMessage) => void;
  onJump: (id: string) => void;
  onThread: (item: ChatMessage) => void;
  onUpdate: Parameters<typeof MessageCard>[0]['onUpdate'];
  channels: ChannelReference[];
  onChannel: (channel: ChannelReference) => void;
  replyTargetId?: string | null;
}) {
  const { request, state, socket } = useAuth();
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const pageCursor = useRef<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const anchor = panel.kind === 'thread' ? panel.anchorId : null;
  const path = '/conversations/' + conversation.id + (anchor ? '/threads/' + anchor : '/pins');
  const load = useCallback(
    async (cursor: string | null = null, refresh = false) => {
      const current = ++version.current;
      pageCursor.current = cursor;
      setBusy(true);
      setError('');
      if (!refresh) {
        setLoading(true);
        setItems([]);
        setRoot(null);
      }
      try {
        const page = await requestRef.current<PinnedPage | ThreadPage>(
          path + (cursor ? '?before=' + cursor : ''),
        );
        if (current !== version.current) return;
        setItems(page.messages);
        setBefore(page.nextBefore);
        if ('root' in page) setRoot(page.root);
        if ('total' in page) setTotal(page.total);
      } catch (error) {
        if (current === version.current) {
          setItems([]);
          setRoot(null);
          setError((error as Error).message);
        }
      } finally {
        if (current === version.current) {
          setBusy(false);
          setLoading(false);
        }
      }
    },
    [path],
  );
  useEffect(() => {
    let active = true,
      running = false,
      again = false;
    pageCursor.current = null;
    const refresh = async (initial = false) => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        await load(initial ? null : pageCursor.current, !initial);
        initial = false;
      } while (active && again);
      running = false;
    };
    void refresh(true);
    const changed = (event: { conversationId: string }) => {
      if (event.conversationId === conversation.id) void refresh();
    };
    const reconnect = () => void refresh();
    socket?.on('conversation:changed', changed);
    socket?.on('connect', reconnect);
    return () => {
      version.current++;
      active = false;
      socket?.off('conversation:changed', changed);
      socket?.off('connect', reconnect);
    };
  }, [load, socket, conversation.id]);
  const common = {
    userId: state.user.id,
    canPin: conversation.kind !== 'group' || conversation.managerId === state.user.id,
    archived: conversation.archived,
    onReply,
    onThread,
    onJump,
    onUpdate,
    channels,
    onChannel,
  };
  return (
    <aside
      className="chat-feature-panel"
      aria-label={anchor ? 'Thread' : 'Pinned messages'}
      aria-busy={busy || loading}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <header>
        <span className="panel-title-icon">
          {anchor ? <MessageSquare size={18} /> : <Pin size={18} />}
        </span>
        <h2>
          {anchor ? 'Thread' : loading ? 'Pinned messages' : 'Pinned messages (' + total + ')'}
        </h2>
        <button
          className="panel-icon-button"
          disabled={busy}
          title={anchor ? 'Refresh replies' : 'Refresh pins'}
          aria-label={anchor ? 'Refresh replies' : 'Refresh pins'}
          onClick={() => void load()}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button onClick={onClose} aria-label="Close chat panel">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <p>
        {anchor
          ? 'Replies, together in one place. Reading here leaves the main timeline unread.'
          : 'The moments worth keeping close.'}
      </p>
      {error && (
        <div role="alert">
          {error} <button onClick={() => void load(pageCursor.current)}>Retry</button>
        </div>
      )}
      {loading ? (
        <div
          className="panel-loading"
          role="status"
          aria-label={anchor ? 'Loading thread' : 'Loading pinned messages'}
        >
          <span>Loading…</span>
          <div className="panel-skeleton" aria-hidden="true" />
          <div className="panel-skeleton" aria-hidden="true" />
          <div className="panel-skeleton" aria-hidden="true" />
        </div>
      ) : (
        <div className="chat-panel-history">
          {anchor &&
            (root ? (
              <MessageCard item={root} {...common} replyTarget={root.id === replyTargetId} />
            ) : (
              <p>Original unavailable</p>
            ))}
          {before && (
            <button disabled={busy} onClick={() => void load(before)}>
              Load older {anchor ? 'replies' : 'pins'}
            </button>
          )}
          {!items.length && (
            <div className="panel-empty">
              {anchor ? <MessageSquare size={30} /> : <Pin size={30} />}
              <strong>{anchor ? 'A little room for a reply' : 'Nothing pinned yet'}</strong>
              <p>
                {anchor
                  ? 'Reply to a message to keep the conversation going.'
                  : 'Save a message from its menu and find it here.'}
              </p>
            </div>
          )}
          {items.map((item) => (
            <div key={item.id}>
              <MessageCard item={item} {...common} replyTarget={item.id === replyTargetId} />
              {!anchor && (
                <button className="pin-jump" onClick={() => onJump(item.id)}>
                  Jump to original <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
});
