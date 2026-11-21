import { runInBackground } from '../../shared/background';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  Conversation,
  PinnedPage,
  ThreadPage,
  ChannelReference,
} from '@tricord/shared';
import { CircleAlert, Pin, MessageSquare, RefreshCw, X, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../account';
import { MessageCard } from './MessageCard';
import type { NavigateToChannel } from './channel-references';

export type OpenChatPanel = { kind: 'pins' } | { kind: 'thread'; anchorId: string };
type PanelView =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; page: PinnedPage | ThreadPage; older: boolean };
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
  onChannel: NavigateToChannel;
  replyTargetId?: string | null;
}) {
  const { request, state, socket } = useAuth();
  const [view, setView] = useState<PanelView>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const version = useRef(0);
  const pageCursor = useRef<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const anchor = panel.kind === 'thread' ? panel.anchorId : null;
  const path = '/conversations/' + conversation.id + (anchor ? '/threads/' + anchor : '/pins');
  useEffect(() => {
    if (open && panel.kind === 'pins') heading.current?.focus({ preventScroll: true });
  }, [open, panel.kind]);
  const load = useCallback(
    async (cursor: string | null = null, refresh = false) => {
      const current = ++version.current;
      pageCursor.current = cursor;
      setBusy(true);
      if (!refresh) setView({ phase: 'loading' });
      try {
        const page = await requestRef.current<PinnedPage | ThreadPage>(
          path + (cursor ? '?before=' + cursor : ''),
        );
        if (current !== version.current) return;
        setView({ phase: 'loaded', page, older: cursor !== null });
      } catch (error) {
        if (current === version.current) {
          setView({ phase: 'error', message: (error as Error).message });
        }
      } finally {
        if (current === version.current) {
          setBusy(false);
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
    runInBackground(refresh(true));
    const changed = (event: { conversationId: string }) => {
      if (event.conversationId === conversation.id) runInBackground(refresh());
    };
    const reconnect = () => runInBackground(refresh());
    socket?.on('conversation:changed', changed);
    socket?.on('connect', reconnect);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the current async generation; this is not a DOM ref.
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
  const page = view.phase === 'loaded' ? view.page : null;
  const total = page && 'total' in page ? page.total : 0;
  const root = page && 'root' in page ? page.root : null;
  function loadFromPanel(cursor: string | null = null) {
    heading.current?.focus({ preventScroll: true });
    runInBackground(load(cursor));
  }
  return (
    <aside
      id={'chat-panel-' + conversation.id}
      className="chat-feature-panel"
      data-kind={panel.kind}
      aria-label={anchor ? 'Thread' : 'Pinned messages'}
      aria-busy={busy || view.phase === 'loading'}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(event) => {
        if (
          panel.kind === 'pins' &&
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <span className="panel-title-icon">
          {anchor ? <MessageSquare size={18} /> : <Pin size={18} />}
        </span>
        <h2 ref={heading} tabIndex={-1}>
          {anchor ? 'Thread' : total ? 'Pinned messages (' + total + ')' : 'Pinned messages'}
        </h2>
        <button
          className="panel-icon-button"
          disabled={busy}
          title={anchor ? 'Refresh replies' : 'Refresh pins'}
          aria-label={anchor ? 'Refresh replies' : 'Refresh pins'}
          onClick={() => loadFromPanel()}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button onClick={onClose} aria-label="Close chat panel">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      {view.phase === 'loading' ? (
        <div
          className="panel-loading"
          role="status"
          aria-label={anchor ? 'Loading thread' : 'Loading pinned messages'}
        >
          {anchor ? 'Loading replies…' : 'Loading pinned messages…'}
        </div>
      ) : view.phase === 'error' ? (
        <div className="panel-error">
          <div role="alert">
            <CircleAlert size={18} aria-hidden="true" /> {view.message}
          </div>
          <button className="panel-retry" onClick={() => loadFromPanel(pageCursor.current)}>
            Retry
          </button>
        </div>
      ) : (
        <div className="chat-panel-history">
          {anchor &&
            (root ? (
              <MessageCard item={root} {...common} replyTarget={root.id === replyTargetId} />
            ) : (
              <p>Original unavailable</p>
            ))}
          {view.page.nextBefore && (
            <button disabled={busy} onClick={() => loadFromPanel(view.page.nextBefore)}>
              Load older {anchor ? 'replies' : 'pins'}
            </button>
          )}
          {!view.page.messages.length && !view.older && (
            <div className="panel-empty">
              <strong>{anchor ? 'No replies yet' : 'No pinned messages'}</strong>
              {!anchor && common.canPin && !conversation.archived && (
                <p>Choose “Pin message” from a message’s menu to save it here.</p>
              )}
            </div>
          )}
          {!view.page.messages.length && view.older && (
            <p className="panel-empty">{anchor ? 'No older replies.' : 'No older pins.'}</p>
          )}
          {view.page.messages.map((item) => (
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
