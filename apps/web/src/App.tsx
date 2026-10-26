import { Notifications } from './Notifications';
import { mentionsUser } from '@tricord/shared';
import { VoicePanel } from './VoicePanel';
import { mergeMessages } from './message-state';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Hash,
  Users,
  Settings,
  Plus,
  Send,
  MessageCircle,
  ChevronDown,
  ShieldCheck,
  Menu,
  X,
  LogOut,
} from 'lucide-react';
import { Avatar } from '@tricord/ui';
import type {
  Conversation,
  ChatMessage,
  MessagePage,
  Invitation,
  AuthUser,
  ChatAck,
  ConversationUnread,
} from '@tricord/shared';
import { AuthRoot, useAuth } from './Auth';
import './auth.css';
import './chat.css';
export function App() {
  return (
    <AuthRoot>
      <Community />
    </AuthRoot>
  );
}
function Community() {
  const { state, connected, socket, request, openSettings, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [invites, setInvites] = useState<Invitation[]>([]),
    [members, setMembers] = useState<AuthUser[]>([]);
  const [selected, setSelected] = useState<string | null>(null),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState(''),
    [modal, setModal] = useState<'channel' | 'dm' | 'group' | 'manage' | null>(null),
    [busy, setBusy] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const reloadVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++reloadVersion.current;
    try {
      const [data, inbox, people] = await Promise.all([
        requestRef.current<{ conversations: Conversation[] }>('/conversations'),
        requestRef.current<{ invitations: Invitation[] }>('/invitations'),
        requestRef.current<{ users: AuthUser[] }>('/members'),
      ]);
      if (version !== reloadVersion.current) return;
      setConversations(data.conversations);
      setInvites(inbox.invitations);
      setMembers(people.users);
      setSelected((current) =>
        data.conversations.some((c) => c.id === current)
          ? current
          : (data.conversations.find((c) => c.kind === 'channel' && !c.archived)?.id ?? null),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!socket) return;
    const changed = () => void reload();
    const unreadChanged = (data: ConversationUnread) =>
      setConversations((previous) =>
        previous.map((c) => {
          if (
            c.id !== data.id ||
            BigInt(data.lastReadSeq) < BigInt(c.lastReadSeq) ||
            BigInt(data.activity) < BigInt(c.activity)
          )
            return c;
          return { ...c, ...data };
        }),
      );
    socket.on('unread:changed', unreadChanged);
    socket.on('inbox:changed', changed);
    socket.on('connect', changed);
    socket.on('conversation:closed', changed);
    window.addEventListener('focus', changed);
    return () => {
      socket.off('unread:changed', unreadChanged);
      socket.off('inbox:changed', changed);
      socket.off('connect', changed);
      socket.off('conversation:closed', changed);
      window.removeEventListener('focus', changed);
    };
  }, [socket, reload]);
  const unreadTotal = conversations.reduce((total, c) => total + c.unreadCount, 0);
  useEffect(() => {
    document.title = (unreadTotal ? '(' + unreadTotal + ') ' : '') + 'Tricord';
    return () => {
      document.title = 'Tricord';
    };
  }, [unreadTotal]);
  const current = conversations.find((c) => c.id === selected);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await action(async () => {
      const body =
        modal === 'dm'
          ? { kind: 'dm', userId: data.get('userId') }
          : {
              kind: modal,
              name: data.get('name'),
              ...(modal === 'group' ? { userIds: data.getAll('userIds') } : {}),
            };
      const result = await request<{ conversation: Conversation }>('/conversations', 'POST', body);
      setSelected(result.conversation.id);
      setModal(null);
    });
  }
  const choose = (id: string) => {
    setSelected(id);
    setMobile(false);
    setError('');
  };
  return (
    <div className={'shell live-shell' + (mobile ? ' mobile-open' : '')}>
      <nav className="rail" aria-label="Platform">
        <div className="logo">
          t<span>•</span>
        </div>
        <div className="rail-rule" />
        <button
          className="rail-active"
          aria-label="Conversations"
          onClick={() => setMobile(!mobile)}
        >
          <MessageCircle />
        </button>
        <button aria-label="New direct message" onClick={() => setModal('dm')}>
          <Users />
        </button>
        <div className="grow" />
        <button aria-label="Settings" onClick={openSettings}>
          <Settings />
        </button>
      </nav>
      <aside className="sidebar">
        <div className="community">
          <div>
            <strong>
              Tricord<span>.</span>
            </strong>
            <small>YOUR PEOPLE, YOUR PLACE</small>
          </div>
          <ChevronDown size={16} />
        </div>
        <div className="private-label">
          <ShieldCheck size={13} /> Our private corner <span>01</span>
        </div>
        <div className="section-label">
          TEXT CHANNELS
          <button aria-label="Create channel" onClick={() => setModal('channel')}>
            <Plus size={15} />
          </button>
        </div>
        <div className="channels">
          {conversations
            .filter((c) => c.kind === 'channel')
            .map((c) => (
              <button
                key={c.id}
                className={
                  (selected === c.id ? 'selected ' : '') + (c.unreadCount ? 'has-unread' : '')
                }
                data-conversation-id={c.id}
                onClick={() => choose(c.id)}
              >
                <Hash size={18} />
                <span className="truncate">{c.name}</span>
                {c.unreadCount > 0 && (
                  <span className="unread-badge" aria-label={c.unreadCount + ' unread messages'}>
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
                {c.mentionCount > 0 && (
                  <span className="mention-badge" aria-label={c.mentionCount + ' unread mentions'}>
                    @{c.mentionCount}
                  </span>
                )}
                {c.archived && <small>Archived</small>}
              </button>
            ))}
        </div>
        <div className="section-label">
          DIRECT MESSAGES
          <button aria-label="Create group" onClick={() => setModal('group')}>
            <Plus size={15} />
          </button>
        </div>
        <button className="new-dm" onClick={() => setModal('dm')}>
          <MessageCircle size={15} /> New direct message
        </button>
        <div className="channels">
          {conversations
            .filter((c) => c.kind !== 'channel')
            .map((c) => (
              <button
                key={c.id}
                className={
                  (selected === c.id ? 'selected ' : '') + (c.unreadCount ? 'has-unread' : '')
                }
                data-conversation-id={c.id}
                onClick={() => choose(c.id)}
              >
                {c.kind === 'group' ? <Users size={18} /> : <MessageCircle size={18} />}
                <span className="truncate">{c.name}</span>
                {c.unreadCount > 0 && (
                  <span className="unread-badge" aria-label={c.unreadCount + ' unread messages'}>
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
                {c.mentionCount > 0 && (
                  <span className="mention-badge" aria-label={c.mentionCount + ' unread mentions'}>
                    @{c.mentionCount}
                  </span>
                )}
              </button>
            ))}
        </div>
        {invites.length > 0 && (
          <div className="invite-list">
            <div className="section-label">INVITATIONS · {invites.length}</div>
            {invites.map((invite) => (
              <div className="invite-card" key={invite.id}>
                <strong>{invite.name}</strong>
                <small>From {invite.inviter}</small>
                <p>History starts when you join.</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await request('/invitations/' + invite.id, 'POST', { accept: true });
                      setSelected(invite.conversationId);
                    })
                  }
                >
                  Accept
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      request('/invitations/' + invite.id, 'POST', { accept: false }),
                    )
                  }
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        )}
        <Notifications key={state.user.id} selected={selected} onOpen={choose} />
        <VoicePanel />
        <div className="grow" />
        <div className="profile">
          <Avatar>{state.user.displayName.slice(0, 1)}</Avatar>
          <div>
            <strong>{state.user.displayName}</strong>
            <small>{state.user.isOwner ? 'Platform owner' : 'Member · administrator'}</small>
          </div>
          <button aria-label="Sign out" onClick={() => void logout()}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <section className="chat">
        <header className="channel-header">
          <button
            className="mobile-menu"
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          {current?.kind === 'channel' ? <Hash size={23} /> : <MessageCircle size={23} />}
          <strong className="truncate">{current?.name ?? 'Your conversations'}</strong>
          <span className="header-divider" />
          <span className="channel-topic">
            {current?.kind === 'channel'
              ? 'A shared space for your community.'
              : 'Only conversation members can read these messages.'}
          </span>
          <div className="grow" />
          {current && (
            <button aria-label="Manage conversation" onClick={() => setModal('manage')}>
              <Settings size={18} />
            </button>
          )}
        </header>
        {error && (
          <div className="notice" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {current ? (
          <Messages key={current.id} conversation={current} readingAllowed={!mobile && !modal} />
        ) : (
          <div className="empty-channel">
            <MessageCircle size={34} />
            <h1>Your people are here.</h1>
            <p>Create a channel, start a DM, or accept a group invitation.</p>
            <button className="primary" onClick={() => setModal('dm')}>
              Start a conversation
            </button>
          </div>
        )}
      </section>
      <aside className="members">
        <header>
          <Users size={17} /> {current?.kind === 'channel' ? 'THE PEOPLE' : 'PARTICIPANTS'}
          <span>{current?.members.length ?? members.length}</span>
        </header>
        <div className="section-label">
          {current?.kind === 'group' ? 'GROUP MEMBERS' : 'COMMUNITY'}
        </div>
        {(current?.members ?? members).map((person) => (
          <button
            className="member member-button"
            key={person.id}
            onClick={() => {
              if (person.id !== state.user.id)
                void action(async () => {
                  const data = await request<{ conversation: Conversation }>(
                    '/conversations',
                    'POST',
                    { kind: 'dm', userId: person.id },
                  );
                  setSelected(data.conversation.id);
                });
            }}
            disabled={person.id === state.user.id || person.status !== 'approved'}
          >
            <Avatar>{person.displayName.slice(0, 1)}</Avatar>
            <div>
              <strong>{person.displayName}</strong>
              <small>
                {current?.managerId === person.id
                  ? 'Group manager'
                  : person.id === state.user.id
                    ? 'You'
                    : person.status === 'approved'
                      ? '@' + person.username
                      : 'Unavailable'}
              </small>
            </div>
          </button>
        ))}
        <div className="member-note">
          <button onClick={openSettings}>Manage accounts & approvals →</button>
        </div>
        <div className="grow" />
        <div className="system-card" data-connection={connected ? 'connected' : 'disconnected'}>
          <strong>{connected ? 'Connected' : 'Reconnecting…'}</strong>
          <p>
            {connected
              ? 'Messages are saved to your server.'
              : 'Your draft stays here. We’ll catch up when connected.'}
          </p>
        </div>
        <div className="version">
          TRICORD <span>Voice & text</span>
        </div>
      </aside>
      {modal && (
        <div className="modal-backdrop">
          <section
            className="account-panel chat-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={modal === 'manage' ? 'Manage conversation' : 'New conversation'}
          >
            <header>
              <h2>
                {modal === 'channel'
                  ? 'Create a channel'
                  : modal === 'dm'
                    ? 'Start a direct message'
                    : modal === 'group'
                      ? 'Create a group'
                      : current?.name}
              </h2>
              <button aria-label="Close dialog" onClick={() => setModal(null)}>
                <X />
              </button>
            </header>
            <div className="account-content">
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              {modal !== 'manage' ? (
                <form onSubmit={(e) => void create(e)}>
                  {modal !== 'dm' && (
                    <label>
                      {modal === 'channel' ? 'Channel name' : 'Group name'}
                      <input
                        autoFocus
                        name="name"
                        maxLength={modal === 'channel' ? 48 : 80}
                        required
                        placeholder={modal === 'channel' ? 'game-night' : 'The usual suspects'}
                      />
                    </label>
                  )}
                  {modal === 'dm' ? (
                    <label>
                      Member
                      <select name="userId" required>
                        {members
                          .filter((m) => m.id !== state.user.id)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.displayName} (@{m.username})
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : (
                    modal === 'group' && (
                      <>
                        <p>
                          Invite friends to join. Each person must accept before seeing messages.
                        </p>
                        {members
                          .filter((m) => m.id !== state.user.id)
                          .map((m) => (
                            <label className="check-label" key={m.id}>
                              <input type="checkbox" name="userIds" value={m.id} />
                              {m.displayName}
                            </label>
                          ))}
                      </>
                    )
                  )}
                  <button className="primary" disabled={busy}>
                    {modal === 'dm' ? 'Open conversation' : 'Create'}
                  </button>
                </form>
              ) : (
                current && (
                  <>
                    {current.kind !== 'dm' &&
                      (current.kind === 'channel' || current.managerId === state.user.id) && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const name = new FormData(e.currentTarget).get('name');
                            void action(() =>
                              request('/conversations/' + current.id, 'PATCH', { name }),
                            );
                          }}
                        >
                          <label>
                            Name
                            <input
                              name="name"
                              defaultValue={current.name}
                              required
                              maxLength={current.kind === 'channel' ? 48 : 80}
                            />
                          </label>
                          <button className="secondary" disabled={busy}>
                            Rename
                          </button>
                        </form>
                      )}
                    {current.kind === 'channel' && (
                      <>
                        <p>
                          Archiving stops new messages. Everyone retains history; authors can still
                          edit or delete their own messages.
                        </p>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              request('/conversations/' + current.id, 'PATCH', {
                                archived: !current.archived,
                              }),
                            )
                          }
                        >
                          {current.archived ? 'Restore channel' : 'Archive channel'}
                        </button>
                      </>
                    )}
                    {current.kind === 'dm' && (
                      <p>This conversation is private to its two participants.</p>
                    )}
                    {current.kind === 'group' && (
                      <>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const userId = new FormData(e.currentTarget).get('userId');
                            void action(() =>
                              request('/conversations/' + current.id + '/invitations', 'POST', {
                                userId,
                              }),
                            );
                          }}
                        >
                          <label>
                            Invite a member
                            <select name="userId" required>
                              <option value="">Choose a friend</option>
                              {members
                                .filter(
                                  (m) => !current.members.some((member) => member.id === m.id),
                                )
                                .map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.displayName}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button className="secondary" disabled={busy}>
                            Send invitation
                          </button>
                        </form>
                        <p>
                          New members cannot see earlier messages. Returning members can see their
                          previous membership periods, excluding messages sent while away.
                        </p>
                        {current.members.map((member) => (
                          <div className="account-row" key={member.id}>
                            <strong>
                              {member.displayName}
                              {member.id === current.managerId ? ' · Manager' : ''}
                            </strong>
                            {current.managerId === state.user.id && member.id !== state.user.id && (
                              <div className="account-actions">
                                <button
                                  className="secondary"
                                  disabled={busy || member.status !== 'approved'}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        'Transfer group management to ' + member.displayName + '?',
                                      )
                                    )
                                      void action(() =>
                                        request(
                                          '/conversations/' + current.id + '/membership',
                                          'POST',
                                          { action: 'transfer', userId: member.id },
                                        ),
                                      );
                                  }}
                                >
                                  Make manager
                                </button>
                                <button
                                  className="danger"
                                  disabled={busy}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        'Remove ' + member.displayName + ' from this group?',
                                      )
                                    )
                                      void action(() =>
                                        request(
                                          '/conversations/' + current.id + '/membership',
                                          'POST',
                                          { action: 'remove', userId: member.id },
                                        ),
                                      );
                                  }}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Leave this group? You need a new invitation to return.',
                              )
                            )
                              void action(async () => {
                                await request(
                                  '/conversations/' + current.id + '/membership',
                                  'POST',
                                  { action: 'leave' },
                                );
                                setModal(null);
                              });
                          }}
                        >
                          Leave group
                        </button>
                      </>
                    )}
                  </>
                )
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function Messages({
  conversation,
  readingAllowed,
}: {
  conversation: Conversation;
  readingAllowed: boolean;
}) {
  const { state, request, socket, connected } = useAuth();
  const [items, setItems] = useState<ChatMessage[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [draft, setDraft] = useState(''),
    [sending, setSending] = useState(false),
    [olderBusy, setOlderBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [editText, setEditText] = useState('');
  const change = useRef('0'),
    loaded = useRef(false),
    alive = useRef(true),
    running = useRef<Promise<void> | null>(null),
    again = useRef(false),
    bottom = useRef<HTMLDivElement>(null),
    outbox = useRef<{ clientId: string; body: string } | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const path = '/conversations/' + conversation.id;
  const scroll = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    readSeq = useRef(conversation.lastReadSeq);
  const [atBottom, setAtBottom] = useState(true);
  const lastReadRequest = useRef(0);
  const latestSeq = items.reduce(
    (max, item) => (BigInt(item.seq) > BigInt(max) ? item.seq : max),
    '0',
  );
  useEffect(() => {
    let active = true,
      pending = false;
    const mark = () => {
      if (
        !active ||
        pending ||
        Date.now() - lastReadRequest.current < (socket?.connected ? 5000 : 15000) ||
        loading ||
        !readingAllowed ||
        !!document.querySelector('[role="dialog"]') ||
        !pinned.current ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        BigInt(latestSeq) <= BigInt(readSeq.current)
      )
        return;
      pending = true;
      lastReadRequest.current = Date.now();
      const result = socket?.connected
        ? new Promise<{ lastReadSeq: string }>((resolve, reject) => {
            socket
              .timeout(10000)
              .emit(
                'conversation:read',
                { conversationId: conversation.id, seq: latestSeq },
                (timeout, ack) => {
                  if (timeout) reject(new Error('Read acknowledgement timed out.'));
                  else if (!ack.ok) reject(new Error(ack.error));
                  else resolve(ack.data);
                },
              );
          })
        : requestRef.current<{ lastReadSeq: string }>(path + '/read', 'POST', { seq: latestSeq });
      void result
        .then((result) => {
          readSeq.current = result.lastReadSeq;
        })
        .catch(() => {
          /* Retry on focus or the next visible update. */
        })
        .finally(() => {
          pending = false;
        });
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    const retry = setTimeout(
      mark,
      Math.max(0, (socket?.connected ? 5000 : 15000) - (Date.now() - lastReadRequest.current)),
    );
    const timer = setInterval(mark, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(retry);
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [latestSeq, loading, atBottom, path, readingAllowed, socket, connected, conversation.id]);
  const synchronize = useCallback(() => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    running.current = (async () => {
      do {
        again.current = false;
        try {
          if (!loaded.current) {
            const page = await requestRef.current<MessagePage>(
              '/conversations/' + conversation.id + '/messages',
            );
            if (!alive.current) return;
            setItems(page.messages);
            setBefore(page.nextBefore);
            change.current = page.change;
            loaded.current = true;
            setLoading(false);
          } else {
            let more = true;
            while (more) {
              const page = await requestRef.current<MessagePage>(
                '/conversations/' +
                  conversation.id +
                  '/messages?afterChange=' +
                  change.current +
                  '&limit=100',
              );
              if (!alive.current) return;
              setItems((previous) => mergeMessages(previous, page.messages));
              change.current = page.change;
              more = page.hasMore;
            }
          }
          setError('');
        } catch (e) {
          if (alive.current) {
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
  }, [conversation.id]);
  useEffect(() => {
    alive.current = true;
    void synchronize();
    return () => {
      alive.current = false;
    };
  }, [synchronize]);
  useEffect(() => {
    if (!socket) return;
    const join = () =>
      socket.emit('conversation:join', { conversationId: conversation.id }, (ack) => {
        if (ack.ok) void synchronize();
        else if (alive.current) setError(ack.error);
      });
    const changed = (data: { conversationId: string }) => {
      if (data.conversationId === conversation.id) void synchronize();
    };
    socket.on('connect', join);
    socket.on('conversation:changed', changed);
    if (socket.connected) join();
    const focus = () => void synchronize();
    window.addEventListener('focus', focus);
    return () => {
      socket.off('connect', join);
      socket.off('conversation:changed', changed);
      window.removeEventListener('focus', focus);
    };
  }, [socket, conversation.id, synchronize]);
  useEffect(() => {
    if (!olderBusy && pinned.current) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [items.length]);
  async function older() {
    if (!before) return;
    setOlderBusy(true);
    try {
      const page = await request<MessagePage>(path + '/messages?before=' + before);
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, page.messages));
        setBefore(page.nextBefore);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOlderBusy(false);
    }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setError('');
    if (outbox.current?.body !== draft)
      outbox.current = { clientId: crypto.randomUUID(), body: draft };
    const pending = outbox.current!;
    try {
      let message: ChatMessage;
      if (socket?.connected) {
        const ack = await new Promise<ChatAck<ChatMessage>>((resolve, reject) => {
          socket
            .timeout(10000)
            .emit(
              'message:send',
              { conversationId: conversation.id, ...pending },
              (timeout, result) =>
                timeout
                  ? reject(new Error('Delivery not confirmed. Retry safely with the same draft.'))
                  : resolve(result),
            );
        });
        if (!ack.ok) throw new Error(ack.error);
        message = ack.data;
      } else
        message = (await request<{ message: ChatMessage }>(path + '/messages', 'POST', pending))
          .message;
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, [message]));
        setDraft('');
        outbox.current = null;
        void synchronize();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function modify(item: ChatMessage, remove = false) {
    try {
      setError('');
      const data = await request<{ message: ChatMessage }>(
        path + '/messages/' + item.id,
        remove ? 'DELETE' : 'PATCH',
        remove ? undefined : { body: editText },
      );
      setItems((previous) => mergeMessages(previous, [data.message]));
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div
        className="message-scroll"
        aria-live="polite"
        ref={scroll}
        onScroll={() => {
          const area = scroll.current;
          if (area) {
            pinned.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48;
            setAtBottom(pinned.current);
          }
        }}
      >
        {loading ? (
          <p className="chat-status" role="status">
            Loading conversation…
          </p>
        ) : (
          <>
            {before && (
              <button className="load-older" disabled={olderBusy} onClick={() => void older()}>
                {olderBusy ? 'Loading…' : 'Load older messages'}
              </button>
            )}
            <div className="conversation-intro">
              <div className="welcome-hash">
                {conversation.kind === 'channel' ? <Hash size={30} /> : <MessageCircle size={30} />}
              </div>
              <h1>{conversation.name}</h1>
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
              .map((item) => (
                <article
                  className={
                    'message live-message' +
                    (mentionsUser(item.body ?? '', state.user.username) ? ' mentions-you' : '')
                  }
                  key={item.id}
                  data-message-id={item.id}
                >
                  <Avatar>{item.author.displayName.slice(0, 1)}</Avatar>
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>{item.author.displayName}</strong>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                      {item.editedAt && <small>edited</small>}
                    </div>
                    {editing === item.id ? (
                      <form
                        className="edit-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void modify(item);
                        }}
                      >
                        <textarea
                          aria-label="Edit message"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          maxLength={4000}
                          required
                        />
                        <button className="primary">Save</button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <p className="message-body">{item.body}</p>
                    )}
                  </div>
                  {item.author.id === state.user.id && editing !== item.id && (
                    <div className="message-actions">
                      <button
                        aria-label="Edit message"
                        onClick={() => {
                          setEditing(item.id);
                          setEditText(item.body ?? '');
                        }}
                      >
                        Edit
                      </button>
                      <button
                        aria-label="Delete message"
                        onClick={() => {
                          if (window.confirm('Delete this message permanently?'))
                            void modify(item, true);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </article>
              ))}
            <div ref={bottom} />
          </>
        )}
      </div>
      {error && (
        <div className="notice" role="alert">
          {error}
          <button onClick={() => void synchronize()}>Retry sync</button>
        </div>
      )}
      <div className="composer-wrap">
        <form className="composer live-composer" onSubmit={(e) => void send(e)}>
          <textarea
            name="message"
            aria-label="Message"
            placeholder={
              conversation.archived
                ? 'This channel is archived'
                : conversation.kind === 'channel'
                  ? 'Message #' + conversation.name
                  : 'Message ' + conversation.name
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={4000}
            disabled={conversation.archived || sending}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(e);
              }
            }}
          />
          <button
            aria-label="Send message"
            disabled={conversation.archived || sending || !draft.trim()}
          >
            <Send size={18} />
          </button>
        </form>
        {!atBottom && (
          <button
            type="button"
            className="jump-latest"
            onClick={() => {
              pinned.current = true;
              setAtBottom(true);
              bottom.current?.scrollIntoView({ block: 'nearest' });
            }}
          >
            Jump to latest messages
          </button>
        )}
        <div className="composer-footer">
          <span>
            {sending ? 'Saving…' : draft.length + '/4000 · @username to mention · Enter to send'}
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
    </>
  );
}
