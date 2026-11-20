import { runInBackground } from '../../shared/background';
import { ChatComposer } from './ChatComposer';
import { MessageCard } from './MessageCard';
import { ChatPanel, type OpenChatPanel } from './ChatPanel';
import {
  attemptFor,
  sameMessageGroup,
  DraftStore,
  emptyDraft,
  isConversationAccessError,
  isReplyTargetGone,
  sendPayload,
} from './chat-state';
import { compatibleMessage, mergeMessages } from './message-state';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Hash, MessageCircle } from 'lucide-react';
import type {
  Conversation,
  ChatMessage,
  MessagePage,
  MessageContext,
  NotificationTarget,
  ChannelReference,
} from '@tricord/shared';
import { useAuth } from '../account';
import { encodeChannelReferences, referenceLabel } from './channel-references';
import { deliverMessage } from './message-send';
import { prepareChatImage, chatImageBase64 } from './chat-images';
import { EmojiText } from '../../shared/emoji/EmojiText';
import { trackMessageReading } from './message-reading';
import {
  checkTimelinePosition,
  settlePendingJump,
  pinLatestMessages,
  type PendingJump,
} from './message-timeline';

export function Messages({
  conversation,
  readingAllowed,
  drafts,
  navigation,
  onAccessLost,
  channels,
  onChannel,
}: {
  conversation: Conversation;
  readingAllowed: boolean;
  drafts: DraftStore;
  navigation: (NotificationTarget & { version: number }) | null;
  onAccessLost: (id: string) => void;
  channels: ChannelReference[];
  onChannel: (channel: ChannelReference) => void;
}) {
  const { state, request, requestContract, socket, connected } = useAuth();
  const sessionKey = state.user.id + ':' + state.csrfToken;
  const currentSession = useRef(sessionKey);
  currentSession.current = sessionKey;
  const sendingRef = useRef(false);
  const storedDraft = useSyncExternalStore(
    useCallback(
      (listener) => drafts.subscribe(conversation.id, listener),
      [drafts, conversation.id],
    ),
    useCallback(() => drafts.get(conversation.id) ?? emptyDraft, [drafts, conversation.id]),
  );
  const draft = storedDraft.body;
  const [items, setItems] = useState<ChatMessage[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [olderBusy, setOlderBusy] = useState(false);
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [replyLoading, setReplyLoading] = useState(false);
  const [replyFailed, setReplyFailed] = useState(false);
  const [panel, setPanel] = useState<OpenChatPanel | null>(
    navigation?.thread && navigation.messageId
      ? { kind: 'thread', anchorId: navigation.messageId }
      : null,
  );
  const [retainedPanel, setRetainedPanel] = useState(panel);
  const renderedPanel = panel ?? retainedPanel;
  useEffect(() => {
    if (panel) {
      setRetainedPanel(panel);
      return;
    }
    const timer = setTimeout(
      () => setRetainedPanel(null),
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
    );
    return () => clearTimeout(timer);
  }, [panel]);
  const [historyMode, setHistoryMode] = useState(!!navigation?.messageId);
  const [jumpedId, setJumpedId] = useState<string | null>(null);
  const historyRef = useRef(historyMode);
  historyRef.current = historyMode;
  const loadVersion = useRef(0);
  const pendingJump = useRef<PendingJump>(null);
  const replyVersion = useRef(0);
  const change = useRef('0'),
    loaded = useRef(false),
    alive = useRef(true),
    running = useRef<Promise<void> | null>(null),
    again = useRef(false),
    bottom = useRef<HTMLDivElement>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const path = '/conversations/' + conversation.id;
  const scroll = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    readSeq = useRef(conversation.lastReadSeq);
  const [atBottom, setAtBottom] = useState(true);
  const checkPosition = useCallback(() => {
    checkTimelinePosition(scroll, pinned, pendingJump, setAtBottom);
  }, []);
  useLayoutEffect(() => {
    settlePendingJump(loading, pendingJump, scroll, pinned, checkPosition);
  }, [items, loading, checkPosition]);
  const lastReadRequest = useRef(0);
  const latestSeq = items.reduce(
    (max, item) => (BigInt(item.seq) > BigInt(max) ? item.seq : max),
    '0',
  );
  useEffect(
    () =>
      trackMessageReading({
        conversationId: conversation.id,
        latestSeq,
        readSeq,
        lastReadRequest,
        socket,
        request: (...args) => requestRef.current(...args),
        position: () => ({
          loading,
          loaded: loaded.current,
          readingAllowed,
          historyMode,
          panelOpen: renderedPanel !== null,
          pinned: pinned.current,
          scroll: scroll.current,
        }),
      }),
    [
      latestSeq,
      loading,
      atBottom,
      path,
      readingAllowed,
      socket,
      connected,
      conversation.id,
      historyMode,
      renderedPanel,
    ],
  );
  function remember(body = draft, targetId = drafts.get(conversation.id)?.replyToId ?? null) {
    const previous = drafts.get(conversation.id);
    drafts.set(conversation.id, {
      ...previous,
      body,
      replyToId: targetId,
      attempt: previous?.attempt ?? null,
    });
  }
  function changeDraft(body: string) {
    remember(body);
  }
  function attachImage(file: File) {
    const current = drafts.get(conversation.id) ?? emptyDraft;
    if (current.attachment) throw new Error('Remove the current image before adding another.');
    const attachment = prepareChatImage(file);
    drafts.set(conversation.id, { ...current, attachment, attempt: null });
  }
  function removeImage() {
    const current = drafts.get(conversation.id);
    if (current) drafts.set(conversation.id, { ...current, attachment: undefined, attempt: null });
  }
  const chooseReply = useCallback(
    (item: ChatMessage) => {
      if (item.deleted) return;

      replyVersion.current++;
      setReplyLoading(false);
      setReplyFailed(false);
      setReply(item);
      const stored = drafts.get(conversation.id) ?? emptyDraft;
      drafts.set(conversation.id, { ...stored, replyToId: item.id });
      requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>('textarea[name=message]')?.focus(),
      );
    },
    [drafts, conversation.id],
  );
  const cancelReply = useCallback(() => {
    replyVersion.current++;
    setReplyLoading(false);
    setReplyFailed(false);
    setReply(null);
    const stored = drafts.get(conversation.id) ?? emptyDraft;
    drafts.set(conversation.id, { ...stored, replyToId: null });
    setPanel((previous) => (previous?.kind === 'thread' ? null : previous));
  }, [drafts, conversation.id]);
  useEffect(() => {
    if (storedDraft.replyToId === null) {
      setReply(null);
      setReplyLoading(false);
      setReplyFailed(false);
    }
  }, [storedDraft.replyToId]);
  const restoreReply = useCallback(
    (targetId: string) => {
      const current = ++replyVersion.current;
      setReplyLoading(true);
      setReplyFailed(false);
      void requestRef
        .current<{ message: ChatMessage }>(path + '/messages/' + targetId)
        .then(({ message }) => {
          if (alive.current && current === replyVersion.current) setReply(message);
        })
        .catch((error: Error) => {
          if (!alive.current || current !== replyVersion.current) return;
          if (isReplyTargetGone(error)) {
            setReply(null);
            const previous = drafts.get(conversation.id);
            if (previous) drafts.set(conversation.id, { ...previous, replyToId: null });
            setError('Reply target unavailable: ' + error.message);
          } else setReplyFailed(true);
        })
        .finally(() => {
          if (alive.current && current === replyVersion.current) setReplyLoading(false);
        });
    },
    [conversation.id, drafts, path],
  );
  const retryReply = useCallback(() => {
    const targetId = drafts.get(conversation.id)?.replyToId;
    if (targetId) restoreReply(targetId);
  }, [conversation.id, drafts, restoreReply]);
  useEffect(() => {
    const targetId = drafts.get(conversation.id)?.replyToId;
    if (!targetId) return;
    restoreReply(targetId);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the current async generation; this is not a DOM ref.
      replyVersion.current++;
    };
  }, [conversation.id, drafts, restoreReply]);
  const jump = useCallback(
    async (id: string | null) => {
      const version = ++loadVersion.current;
      pendingJump.current = { id };
      setHistoryMode(true);
      pinned.current = false;
      setAtBottom(false);
      setPanel(null);
      setLoading(true);
      setError('');
      try {
        const page = await requestRef.current<MessageContext>(
          path + (id === null ? '/messages/unread-context' : '/messages/' + id + '/context'),
        );
        if (!alive.current || version !== loadVersion.current) return;
        setItems(page.messages.map(compatibleMessage));
        pendingJump.current = { id: page.anchorId };
        setJumpedId(page.anchorId);
        setHistoryMode(page.hasNewer);
        setBefore(page.nextBefore);
        change.current = page.change;
        loaded.current = true;
      } catch (error) {
        if (alive.current && version === loadVersion.current) {
          pendingJump.current = null;
          setItems([]);
          loaded.current = false;
          setError((error as Error).message);
        }
      } finally {
        if (alive.current && version === loadVersion.current) setLoading(false);
      }
    },
    [path],
  );
  const synchronize = useCallback(() => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    running.current = (async () => {
      const version = loadVersion.current;
      do {
        again.current = false;
        try {
          if (!loaded.current) {
            const page = await requestRef.current<MessagePage>(
              '/conversations/' + conversation.id + '/messages',
            );
            if (!alive.current || version !== loadVersion.current) return;
            setItems(page.messages.map(compatibleMessage));
            setBefore(page.nextBefore);
            change.current = page.change;
            loaded.current = true;
            setLoading(false);
          } else {
            let more = true,
              pages = 0;
            while (more) {
              if (++pages > 4) {
                loaded.current = false;
                setItems([]);
                setError('Many changes occurred while away. Reload latest history to continue.');
                return;
              }
              const page = await requestRef.current<MessagePage>(
                '/conversations/' +
                  conversation.id +
                  '/messages?afterChange=' +
                  change.current +
                  '&limit=100',
              );
              if (!alive.current || version !== loadVersion.current) return;
              checkPosition();
              setItems((previous) => {
                const merged = mergeMessages(
                  previous,
                  page.messages,
                  (item) =>
                    !historyRef.current &&
                    (!previous.length || BigInt(item.seq) >= BigInt(previous[0]!.seq)),
                );
                if (merged.length > 500 && !pinned.current) {
                  setHistoryMode(true);
                  return merged.slice(0, 500);
                }
                return merged.slice(-500);
              });
              setReply((previous) => {
                if (!previous) return null;
                const update = page.messages.find((item) => item.id === previous.id);
                if (update?.deleted) {
                  const stored = drafts.get(conversation.id);
                  if (stored) drafts.set(conversation.id, { ...stored, replyToId: null });
                  return null;
                }
                return update ?? previous;
              });
              change.current = page.change;
              more = page.hasMore;
            }
          }
          setError('');
        } catch (e) {
          if (alive.current && version === loadVersion.current) {
            if (isConversationAccessError(e)) {
              setItems([]);
              setReply(null);
              setPanel(null);
              onAccessLost(conversation.id);
            }
            setError((e as Error).message);
            setLoading(false);
          }
          again.current = false;
        }
      } while (again.current);
    })().finally(() => {
      running.current = null;
    });
    return running.current;
  }, [conversation.id, drafts, onAccessLost, checkPosition]);
  useEffect(() => {
    alive.current = true;
    runInBackground(synchronize());
    return () => {
      alive.current = false;
    };
  }, [synchronize]);
  useEffect(() => {
    if (!navigation?.messageId) return;
    if (navigation.thread) {
      setPanel({ kind: 'thread', anchorId: navigation.messageId });
      setReplyLoading(true);
      const version = ++replyVersion.current;
      void requestRef
        .current<{ message: ChatMessage }>(path + '/messages/' + navigation.messageId)
        .then(({ message }) => {
          if (alive.current && version === replyVersion.current) {
            setReply(message);
            const previous = drafts.get(conversation.id);
            drafts.set(conversation.id, {
              ...previous,
              body: previous?.body ?? '',
              replyToId: message.id,
              attempt: previous?.attempt ?? null,
            });
          }
        })
        .catch((error: Error) => {
          if (alive.current && version === replyVersion.current) setError(error.message);
        })
        .finally(() => {
          if (alive.current && version === replyVersion.current) setReplyLoading(false);
        });
    } else runInBackground(jump(navigation.messageId));
  }, [navigation, path, jump, drafts, conversation.id]);
  useEffect(() => {
    if (!socket) return;
    const join = () =>
      socket.emit('conversation:join', { conversationId: conversation.id }, (ack) => {
        if (ack.ok) runInBackground(synchronize());
        else if (alive.current) {
          setError(ack.error);
          if ([401, 403, 404].includes(ack.status)) onAccessLost(conversation.id);
        }
      });
    const changed = (data: { conversationId: string }) => {
      if (data.conversationId === conversation.id) runInBackground(synchronize());
    };
    const unavailable = () =>
      setError('Chat updates are temporarily unavailable. Your draft is retained; retry sync.');
    socket.on('conversation:changed', changed);
    socket.on('connect', join);
    socket.on('chat:unavailable', unavailable);
    if (socket.connected) join();
    const focus = () => runInBackground(synchronize());
    window.addEventListener('focus', focus);
    return () => {
      socket.off('conversation:changed', changed);
      socket.off('connect', join);
      socket.off('chat:unavailable', unavailable);
      window.removeEventListener('focus', focus);
    };
  }, [socket, conversation.id, synchronize, onAccessLost]);
  useEffect(() => {
    pinLatestMessages(loading, loaded.current, olderBusy, pinned.current, bottom.current);
  }, [items.length, loading, olderBusy]);
  async function older() {
    if (!before) return;
    setOlderBusy(true);
    const version = loadVersion.current;
    const area = scroll.current;
    const height = area?.scrollHeight ?? 0;
    const top = area?.scrollTop ?? 0;
    try {
      const page = await request<MessagePage>(path + '/messages?before=' + before);
      if (alive.current && version === loadVersion.current) {
        setItems((previous) => {
          const merged = mergeMessages(previous, page.messages);
          if (merged.length > 500) setHistoryMode(true);
          return merged.slice(0, 500);
        });
        setBefore(page.nextBefore);
        requestAnimationFrame(() => {
          if (area) area.scrollTop = top + area.scrollHeight - height;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOlderBusy(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (
      (!draft.trim() && !storedDraft.attachment) ||
      sendingRef.current ||
      conversation.archived ||
      replyLoading ||
      replyFailed ||
      (panel?.kind === 'thread' && !reply)
    )
      return;
    const stored = drafts.get(conversation.id) ?? {
      body: draft,
      replyToId: reply?.id ?? null,
      attempt: null,
    };
    const pending = attemptFor(stored);
    if ((pending.wireBody ?? pending.body).length > 4000) {
      setError('Channel links exceed the 4000-character message limit. Shorten this draft.');
      return;
    }
    setSending(true);
    sendingRef.current = true;
    setError('');
    drafts.set(conversation.id, { ...stored, attempt: pending });
    try {
      const attachmentRequest = requestContract;
      const attachment = pending.attachment && {
        mimeType: pending.attachment.mimeType,
        base64: await chatImageBase64(pending.attachment),
      };
      if (attachment && (!alive.current || currentSession.current !== sessionKey)) return;
      const message = attachment
        ? compatibleMessage(
            (
              await attachmentRequest(
                `/conversations/${conversation.id}/messages/with-attachment`,
                'POST',
                {
                  ...sendPayload(pending),
                  attachment,
                },
              )
            ).message,
          )
        : await deliverMessage(requestRef.current, socket, conversation.id, pending);
      if (currentSession.current !== sessionKey) return;
      const current = drafts.get(conversation.id);
      const unchanged =
        current?.body === pending.body &&
        current.replyToId === pending.replyToId &&
        current.attachment === pending.attachment &&
        encodeChannelReferences(current.body, current.references) ===
          (pending.wireBody ?? pending.body) &&
        current.attempt?.clientId === pending.clientId;
      if (unchanged) drafts.delete(conversation.id);
      else if (
        pending.attachment &&
        current?.attachment === pending.attachment &&
        current.attempt?.clientId === pending.clientId
      )
        drafts.set(conversation.id, { ...current, attachment: undefined, attempt: null });
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, [message], !historyRef.current).slice(-500));
        if (unchanged) {
          setReply(null);
          setPanel(null);
        }
        runInBackground(synchronize());
      }
    } catch (e) {
      if (alive.current && currentSession.current === sessionKey) setError((e as Error).message);
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }
  async function sendGif(url: string) {
    if (sendingRef.current || conversation.archived || replyLoading || replyFailed)
      throw new Error('Wait for the current send, or choose an active conversation.');
    const stored = drafts.get(conversation.id) ?? emptyDraft;
    const pending = attemptFor({
      body: url,
      replyToId: stored.replyToId,
      attempt: drafts.mediaAttempts.get(conversation.id) ?? null,
    });
    drafts.mediaAttempts.set(conversation.id, pending);
    setSending(true);
    sendingRef.current = true;
    try {
      const message = await deliverMessage(requestRef.current, socket, conversation.id, pending);
      if (drafts.mediaAttempts.get(conversation.id)?.clientId === pending.clientId)
        drafts.mediaAttempts.delete(conversation.id);
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, [message], !historyRef.current).slice(-500));
        runInBackground(synchronize());
      }
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }
  const update = useCallback(
    async (
      item: ChatMessage,
      action: 'edit' | 'delete' | 'pin' | 'unpin' | 'react' | 'unreact',
      value?: string,
    ) => {
      const suffix =
        action === 'pin' || action === 'unpin'
          ? '/pin'
          : action === 'react' || action === 'unreact'
            ? '/reactions'
            : '';
      const method =
        action === 'edit'
          ? 'PATCH'
          : action === 'delete' || action === 'unpin' || action === 'unreact'
            ? 'DELETE'
            : 'PUT';
      const data = await requestRef.current<{ message: ChatMessage }>(
        path + '/messages/' + item.id + suffix,
        method,
        action === 'edit'
          ? { body: value }
          : action === 'react' || action === 'unreact'
            ? { emoji: value }
            : undefined,
      );
      if (!alive.current) return;
      setItems((previous) => mergeMessages(previous, [data.message], false));
      if (drafts.get(conversation.id)?.replyToId === item.id) {
        if (data.message.deleted) cancelReply();
        else setReply(data.message);
      }
    },
    [path, drafts, conversation.id, cancelReply],
  );
  async function latest() {
    loadVersion.current++;
    pendingJump.current = null;
    loaded.current = false;
    setPanel(null);
    setHistoryMode(false);
    setJumpedId(null);
    pinned.current = true;
    setAtBottom(true);
    setLoading(true);
    if (running.current) await running.current;
    await synchronize();
  }
  const openThread = useCallback(
    (item: ChatMessage) => {
      setPanel({ kind: 'thread', anchorId: item.id });
      chooseReply(item);
    },
    [chooseReply],
  );
  const jumpToMessage = useCallback(
    (id: string) => {
      runInBackground(jump(id));
    },
    [jump],
  );
  const closePanel = useCallback(() => setPanel(null), []);
  return (
    <div className="chat-workspace">
      <div className="chat-tools">
        <button
          disabled={items.some((item) => item.featureVersion === 1)}
          aria-expanded={panel?.kind === 'pins'}
          onClick={() =>
            setPanel((previous) => (previous?.kind === 'pins' ? null : { kind: 'pins' }))
          }
        >
          Pinned messages
        </button>
        <button
          disabled={!conversation.unreadCount || items.some((item) => item.featureVersion === 1)}
          onClick={() => runInBackground(jump(null))}
        >
          Jump to unread
        </button>
        {historyMode && <span role="status">History view · unread progress is unchanged</span>}
        {items.some((item) => item.featureVersion === 1) && (
          <span role="status">
            Enhanced chat is unavailable on this server. Basic text remains available.
          </span>
        )}
      </div>
      <div className="chat-layout">
        <div className="chat-timeline">
          <div className="chat-history-layout">
            <div
              className="message-scroll"
              aria-live="polite"
              ref={scroll}
              onScroll={checkPosition}
            >
              {loading ? (
                <p className="chat-status" role="status">
                  Loading conversation…
                </p>
              ) : (
                <>
                  {before && (
                    <button
                      className="load-older"
                      disabled={olderBusy}
                      onClick={() => runInBackground(older())}
                    >
                      {olderBusy ? 'Loading…' : 'Load older messages'}
                    </button>
                  )}
                  <div
                    className={
                      'conversation-intro' +
                      (items.some((item) => !item.deleted) ? ' conversation-intro-compact' : '')
                    }
                  >
                    <div className="welcome-hash">
                      {conversation.kind === 'channel' ? (
                        <Hash size={30} />
                      ) : (
                        <MessageCircle size={30} />
                      )}
                    </div>
                    <h1>
                      <EmojiText text={conversation.name} />
                    </h1>
                    <p>
                      {conversation.kind === 'group'
                        ? 'Your history includes only messages from your membership periods.'
                        : conversation.kind === 'dm'
                          ? 'A private conversation, just for the two of you.'
                          : 'A little space to keep the conversation going.'}
                    </p>
                  </div>
                  {!items.some((m) => !m.deleted) && (
                    <p className="chat-status">No messages yet. Say hello.</p>
                  )}
                  {items
                    .filter((item) => !item.deleted)
                    .map((item, index, visible) => (
                      <Fragment key={item.id}>
                        {(!visible[index - 1] ||
                          new Date(visible[index - 1]!.createdAt).toDateString() !==
                            new Date(item.createdAt).toDateString()) && (
                          <div
                            className="date-separator"
                            role="separator"
                            aria-label={new Date(item.createdAt).toLocaleDateString()}
                          >
                            {new Date(item.createdAt).toLocaleDateString()}
                          </div>
                        )}
                        <MessageCard
                          item={item}
                          userId={state.user.id}
                          archived={conversation.archived}
                          canPin={
                            conversation.kind !== 'group' ||
                            conversation.managerId === state.user.id
                          }
                          grouped={sameMessageGroup(visible[index - 1], item)}
                          highlighted={jumpedId === item.id}
                          replyTarget={reply?.id === item.id}
                          onReply={chooseReply}
                          onThread={openThread}
                          onJump={jumpToMessage}
                          onUpdate={update}
                          channels={channels}
                          onChannel={onChannel}
                        />
                      </Fragment>
                    ))}
                  <div ref={bottom} />
                </>
              )}
            </div>
            {renderedPanel && (
              <ChatPanel
                panel={renderedPanel}
                open={panel !== null}
                conversation={conversation}
                onClose={closePanel}
                replyTargetId={reply?.id ?? null}
                onReply={chooseReply}
                onThread={openThread}
                onJump={jumpToMessage}
                onUpdate={update}
                channels={channels}
                onChannel={onChannel}
              />
            )}
          </div>
          {error && (
            <div className="notice" role="alert">
              {error}
              <button onClick={() => runInBackground(synchronize())}>Retry sync</button>
            </div>
          )}
          <div className="composer-wrap">
            <ChatComposer
              body={draft}
              onChange={changeDraft}
              onSend={(event) => runInBackground(send(event))}
              onSendGif={sendGif}
              attachment={storedDraft.attachment}
              onAttachImage={attachImage}
              onRemoveImage={removeImage}
              reply={reply}
              replyLoading={replyLoading}
              replyFailed={replyFailed}
              onRetryReply={retryReply}
              onCancelReply={cancelReply}
              disabled={conversation.archived || (panel?.kind === 'thread' && !reply)}
              sending={sending}
              retrying={
                storedDraft.attempt?.body === draft &&
                storedDraft.attempt?.replyToId === storedDraft.replyToId &&
                storedDraft.attempt?.attachment === storedDraft.attachment
              }
              members={conversation.members}
              userId={state.user.id}
              channels={channels}
              onReference={(channel) => {
                const current = drafts.get(conversation.id) ?? emptyDraft;
                const display = referenceLabel(channel);
                if (
                  (current.references?.length ?? 0) >= 32 &&
                  !current.references?.some((reference) => reference.display === display)
                ) {
                  setError('A message supports up to 32 different channel links.');
                  return false;
                }
                drafts.set(conversation.id, {
                  ...current,
                  references: [
                    ...(current.references ?? []).filter(
                      (reference) => reference.display !== display,
                    ),
                    { display, channel },
                  ],
                });
                return true;
              }}
            />
            {(!atBottom || historyMode) && (
              <button
                type="button"
                className="jump-latest"
                onClick={() => runInBackground(latest())}
              >
                Jump to latest messages
              </button>
            )}
            <div className="composer-footer">
              <span>
                {sending
                  ? 'Saving…'
                  : draft.length
                    ? draft.length + '/4000 · Enter to send · Shift+Enter for a new line'
                    : 'Paste a screenshot · @ to mention · /gif for GIFs · Enter to send'}
              </span>
              <span
                data-connection={connected ? 'connected' : 'disconnected'}
                className={connected ? 'connection good' : 'connection'}
              >
                <i />
                {connected ? 'Connected' : 'Reconnecting…'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
