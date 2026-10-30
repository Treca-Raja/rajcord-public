import { Notifications } from './Notifications';
import { ChatComposer } from './ChatComposer';
import { MessageCard } from './MessageCard';
import { ChatPanel, type OpenChatPanel } from './ChatPanel';
import {
  attemptFor,
  sameMessageGroup,
  DraftStore,
  emptyDraft,
  isConversationAccessError,
  nearLatest,
} from './chat-state';
import { CategoryManager, ChannelFields, ChannelSettings } from './Channels';
import { channelCategories, channelFields } from './channel-state';
import { VoicePanel } from './VoicePanel';
import { compatibleMessage, mergeMessages } from './message-state';
import {
  Fragment,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import {
  Hash,
  Users,
  Settings,
  Plus,
  MessageCircle,
  ChevronDown,
  ShieldCheck,
  Menu,
  X,
  LogOut,
  FolderPlus,
  ChevronRight,
} from 'lucide-react';
import { Avatar } from '@tricord/ui';
import type {
  Conversation,
  ChatMessage,
  MessagePage,
  Invitation,
  AuthUser,
  ConversationUnread,
  ChannelCategoryPage,
  MessageContext,
  NotificationTarget,
  ChannelReference,
} from '@tricord/shared';
import { AuthRoot, useAuth } from './Auth';
import type { VoiceChannel } from './voice-controller';
import { encodeChannelReferences, referenceLabel } from './channel-references';
import { deliverMessage } from './message-send';
import { EmojiText } from './EmojiText';
import { AppearanceBrand, AppearanceToggle } from './Appearance';
import './auth.css';
import './chat.css';
export function App() {
  return (
    <AuthRoot>
      <AccountCommunity />
    </AuthRoot>
  );
}
function AccountCommunity() {
  const { state } = useAuth();
  return <Community key={state.user.id} />;
}
function Community() {
  const { state, connected, socket, request, openSettings, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [invites, setInvites] = useState<Invitation[]>([]),
    [members, setMembers] = useState<AuthUser[]>([]);
  const [categoryPage, setCategoryPage] = useState<ChannelCategoryPage>({
    categories: [],
    nextAfter: null,
  });
  const [categoriesBusy, setCategoriesBusy] = useState(false);
  const [voiceChannels, setVoiceChannels] = useState<VoiceChannel[]>([]);
  const [voiceNavigation, setVoiceNavigation] = useState<{ id: string; version: number } | null>(
    null,
  );
  const drafts = useRef(new DraftStore());
  useEffect(() => {
    const store = drafts.current;
    return () => store.clear();
  }, []);
  const [navigation, setNavigation] = useState<(NotificationTarget & { version: number }) | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState(''),
    [modal, setModal] = useState<'channel' | 'dm' | 'group' | 'manage' | 'categories' | null>(null),
    [busy, setBusy] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const dialogTrigger = useRef<HTMLElement | null>(null);
  function openDialog(mode: NonNullable<typeof modal>) {
    dialogTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError('');
    setModal(mode);
  }
  const reloadVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++reloadVersion.current;
    try {
      const [data, inbox, people, categories] = await Promise.all([
        requestRef.current<{ conversations: Conversation[] }>('/conversations'),
        requestRef.current<{ invitations: Invitation[] }>('/invitations'),
        requestRef.current<{ users: AuthUser[] }>('/members'),
        requestRef.current<ChannelCategoryPage>('/channel-categories'),
      ]);
      if (version !== reloadVersion.current) return;
      setConversations(data.conversations);
      setInvites(inbox.invitations);
      setMembers(people.users);
      setCategoryPage(categories);
      const allowed = new Set(data.conversations.map((conversation) => conversation.id));
      for (const id of drafts.current.keys()) if (!allowed.has(id)) drafts.current.forget(id);
      for (const id of drafts.current.mediaAttempts.keys())
        if (!allowed.has(id)) drafts.current.mediaAttempts.delete(id);
      setSelected((current) =>
        data.conversations.some((c) => c.id === current)
          ? current
          : (data.conversations.find((c) => c.kind === 'channel' && !c.archived)?.id ?? null),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const closeConversation = useCallback(
    (id: string) => {
      drafts.current.forget(id);
      setConversations((previous) => previous.filter((conversation) => conversation.id !== id));
      setSelected((previous) => (previous === id ? null : previous));
      void reload();
    },
    [reload],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!socket) return;
    const changed = () => void reload();
    const closed = ({ conversationId }: { conversationId: string }) => {
      closeConversation(conversationId);
    };
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
    socket.on('conversation:closed', closed);
    window.addEventListener('focus', changed);
    return () => {
      socket.off('unread:changed', unreadChanged);
      socket.off('inbox:changed', changed);
      socket.off('connect', changed);
      socket.off('conversation:closed', closed);
      window.removeEventListener('focus', changed);
    };
  }, [socket, reload, closeConversation]);
  const unreadTotal = conversations.reduce((total, c) => total + c.unreadCount, 0);
  useEffect(() => {
    document.title = (unreadTotal ? '(' + unreadTotal + ') ' : '') + 'Rajcord';
    return () => {
      document.title = 'Rajcord';
    };
  }, [unreadTotal]);
  const current = conversations.find((c) => c.id === selected);
  const channelReferences = useMemo<ChannelReference[]>(
    () => [
      ...conversations
        .filter((conversation) => conversation.kind === 'channel')
        .map((conversation) => ({
          id: conversation.id,
          name: conversation.name,
          kind: 'channel' as const,
        })),
      ...voiceChannels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: 'voice' as const,
      })),
    ],
    [conversations, voiceChannels],
  );
  const referenceList = useRef(channelReferences);
  referenceList.current = channelReferences;
  const navigateChannel = useCallback((channel: ChannelReference) => {
    if (
      !referenceList.current.some((entry) => entry.id === channel.id && entry.kind === channel.kind)
    ) {
      setError('That channel is no longer available.');
      return;
    }
    if (channel.kind === 'channel') {
      setSelected(channel.id);
      setNavigation(null);
      setMobile(false);
    } else {
      setVoiceNavigation((previous) => ({ id: channel.id, version: (previous?.version ?? 0) + 1 }));
      if (window.innerWidth <= 700) setMobile(true);
    }
  }, []);
  const categories = channelCategories(conversations, categoryPage.categories);
  async function moreCategories() {
    if (!categoryPage.nextAfter || categoriesBusy) return;
    const version = reloadVersion.current;
    setCategoriesBusy(true);
    try {
      const page = await request<ChannelCategoryPage>(
        '/channel-categories?after=' + encodeURIComponent(categoryPage.nextAfter),
      );
      if (version === reloadVersion.current)
        setCategoryPage((previous) => ({
          categories: [...previous.categories, ...page.categories],
          nextAfter: page.nextAfter,
        }));
    } catch (error) {
      if (version === reloadVersion.current) setError((error as Error).message);
    } finally {
      setCategoriesBusy(false);
    }
  }
  useEffect(() => {
    if (!modal) return;
    const previous = dialogTrigger.current;
    const dialog = document.querySelector<HTMLElement>('.chat-dialog');
    const focusable = () =>
      [
        ...(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
    (dialog?.querySelector<HTMLElement>('input:not(:disabled)') ?? focusable()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModal(null);
      } else if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0],
          last = elements.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialog?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [modal]);
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
        modal === 'channel'
          ? { kind: 'channel', ...channelFields(data) }
          : modal === 'dm'
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
    setNavigation(null);
    setMobile(false);
    setError('');
  };
  return (
    <div className={'shell live-shell' + (mobile ? ' mobile-open' : '')}>
      <nav className="rail" aria-label="Platform">
        <AppearanceBrand />
        <div className="rail-rule" />
        <button
          className="rail-active"
          aria-label="Conversations"
          onClick={() => setMobile(!mobile)}
        >
          <MessageCircle />
        </button>
        <button aria-label="New direct message" onClick={() => openDialog('dm')}>
          <Users />
        </button>
        <AppearanceToggle />
        <div className="grow" />
      </nav>
      <aside className="sidebar" id="community-sidebar" aria-label="Community">
        <div className="community">
          <div>
            <strong>
              Rajcord<span>.</span>
            </strong>
            <small>YOUR LITTLE INTERNET</small>
          </div>
          <ChevronDown size={16} />
        </div>
        <div className="private-label">
          <ShieldCheck size={13} /> Our private corner <span aria-hidden="true">✦</span>
        </div>
        <div className="section-label">
          TEXT CHANNELS
          <div className="channel-management-actions">
            <button aria-label="Create channel" onClick={() => openDialog('channel')}>
              <Plus size={15} />
            </button>
          </div>
        </div>
        <button
          className="manage-categories-link"
          aria-label="Manage categories"
          title="Create or manage categories"
          onClick={() => openDialog('categories')}
        >
          <FolderPlus size={17} aria-hidden="true" />
          <span>
            <strong>Categories</strong>
            <small>Create & manage</small>
          </span>
          <ChevronRight className="category-arrow" size={15} aria-hidden="true" />
        </button>
        <div className="channels">
          {[...categories, null].map((category) => (
            <section
              key={category?.id ?? 'uncategorized'}
              className="channel-category"
              data-category-id={category?.id ?? 'uncategorized'}
              aria-label={category?.name ?? 'Uncategorized'}
            >
              <h2 className="category-heading">{category?.name ?? 'Uncategorized'}</h2>
              {conversations
                .filter(
                  (c) =>
                    c.kind === 'channel' && (c.category?.id ?? null) === (category?.id ?? null),
                )
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
                    <span className="truncate">
                      <EmojiText text={c.name} />
                    </span>
                    {c.unreadCount > 0 && (
                      <span
                        className="unread-badge"
                        aria-label={c.unreadCount + ' unread messages'}
                      >
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    )}
                    {c.mentionCount > 0 && (
                      <span
                        className="mention-badge"
                        aria-label={c.mentionCount + ' unread mentions'}
                      >
                        @{c.mentionCount}
                      </span>
                    )}
                    {c.archived && <small>Archived</small>}
                  </button>
                ))}
            </section>
          ))}
        </div>
        <div className="section-label">
          DIRECT MESSAGES
          <button aria-label="Create group" onClick={() => openDialog('group')}>
            <Plus size={15} />
          </button>
        </div>
        <button className="new-dm" onClick={() => openDialog('dm')}>
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
                <span className="truncate">
                  <EmojiText text={c.name} />
                </span>
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
        <VoicePanel onChannels={setVoiceChannels} requestedChannel={voiceNavigation} />
        <div className="grow" />
        <div className="profile">
          <Avatar>{state.user.displayName.slice(0, 1)}</Avatar>
          <div>
            <strong>{state.user.displayName}</strong>
            <small>{state.user.isOwner ? 'Platform owner' : 'Member · administrator'}</small>
          </div>
          <button aria-label="Sign out" title="Sign out" onClick={() => void logout()}>
            <LogOut size={16} />
          </button>
          <button
            className="profile-settings"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings()}
          >
            <Settings size={19} />
          </button>
        </div>
      </aside>
      <Notifications
        key={state.user.id}
        selected={selected}
        onOpen={(target) => {
          setSelected(target.conversationId);
          setNavigation((previous) => ({ ...target, version: (previous?.version ?? 0) + 1 }));
          setMobile(false);
          setError('');
        }}
      />
      <section className="chat">
        <header className="channel-header">
          <button
            className="mobile-menu"
            aria-label="Toggle navigation"
            aria-controls="community-sidebar"
            aria-expanded={mobile}
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          {current?.kind === 'channel' ? <Hash size={23} /> : <MessageCircle size={23} />}
          <strong className="truncate">
            <EmojiText text={current?.name ?? 'Your conversations'} />
          </strong>
          <span className="header-divider" />
          <span className="channel-topic">
            {current?.kind === 'channel'
              ? current.topic || 'A shared space for your community.'
              : 'Only conversation members can read these messages.'}
          </span>
          <div className="grow" />
          {current && (
            <button aria-label="Manage conversation" onClick={() => openDialog('manage')}>
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
          <Messages
            key={current.id}
            conversation={current}
            readingAllowed={!mobile && !modal}
            drafts={drafts.current}
            navigation={navigation?.conversationId === current.id ? navigation : null}
            onAccessLost={closeConversation}
            channels={channelReferences}
            onChannel={navigateChannel}
          />
        ) : (
          <div className="empty-channel">
            <MessageCircle size={34} />
            <h1>Your people are here.</h1>
            <p>Create a channel, start a DM, or accept a group invitation.</p>
            <button className="primary" onClick={() => openDialog('dm')}>
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
          <button onClick={() => openSettings('people')}>Manage accounts & approvals →</button>
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
          RAJCORD <span>Good company.</span>
        </div>
      </aside>
      {modal && (
        <div className="modal-backdrop">
          <section
            className="account-panel chat-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === 'manage'
                ? 'Manage conversation'
                : modal === 'categories'
                  ? 'Manage categories'
                  : 'New conversation'
            }
          >
            <header>
              <h2>
                {modal === 'categories'
                  ? 'Manage categories'
                  : modal === 'channel'
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
              {modal === 'categories' ? (
                <CategoryManager categories={categories} onChanged={reload} />
              ) : modal !== 'manage' ? (
                <form onSubmit={(e) => void create(e)}>
                  {modal === 'channel' ? (
                    <>
                      <ChannelFields categories={categories} />
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => openDialog('categories')}
                      >
                        Create or manage categories
                      </button>
                    </>
                  ) : (
                    modal !== 'dm' && (
                      <label>
                        Group name
                        <input
                          autoFocus
                          name="name"
                          maxLength={80}
                          required
                          placeholder="The usual suspects"
                        />
                      </label>
                    )
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
                    {current.kind === 'channel' && (
                      <ChannelSettings
                        key={current.id}
                        conversation={current}
                        categories={categories}
                        onChanged={reload}
                      />
                    )}
                    {current.kind === 'channel' && (
                      <button className="text-button" onClick={() => openDialog('categories')}>
                        Create or manage categories
                      </button>
                    )}
                    {current.kind === 'group' && current.managerId === state.user.id && (
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
                          <input name="name" defaultValue={current.name} required maxLength={80} />
                        </label>
                        <button className="secondary" disabled={busy}>
                          Rename
                        </button>
                      </form>
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
              {categoryPage.nextAfter &&
                (modal === 'channel' || modal === 'manage' || modal === 'categories') && (
                  <button
                    className="secondary"
                    disabled={categoriesBusy}
                    onClick={() => void moreCategories()}
                  >
                    {categoriesBusy ? 'Loading categories…' : 'Load more categories'}
                  </button>
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
  const { state, request, socket, connected } = useAuth();
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
  const pendingJump = useRef<{ id: string | null } | null>(null);
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
    if (pendingJump.current) return;
    const area = scroll.current;
    if (area) {
      pinned.current = nearLatest(area);
      setAtBottom(pinned.current);
    }
  }, []);
  useLayoutEffect(() => {
    const pending = pendingJump.current;
    if (loading || !pending?.id) return;
    // Settle the navigation on the first committed render; never leave scroll tracking suspended.
    pendingJump.current = null;
    const target = scroll.current?.querySelector<HTMLElement>(
      '[data-message-id="' + pending.id + '"]',
    );
    if (target) {
      pinned.current = false;
      target.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      target.focus({ preventScroll: true });
    }
    // A target already in view emits no scroll event, so recompute the reading position explicitly.
    requestAnimationFrame(checkPosition);
  }, [items, loading, checkPosition]);
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
        !loaded.current ||
        !readingAllowed ||
        historyMode ||
        renderedPanel !== null ||
        !!document.querySelector('[role="dialog"]') ||
        !pinned.current ||
        !scroll.current ||
        !nearLatest(scroll.current) ||
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
  }, [
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
  ]);
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
  const chooseReply = useCallback(
    (item: ChatMessage) => {
      if (item.deleted) return;
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
    setReply(null);
    const stored = drafts.get(conversation.id) ?? emptyDraft;
    drafts.set(conversation.id, { ...stored, replyToId: null });
    setPanel((previous) => (previous?.kind === 'thread' ? null : previous));
  }, [drafts, conversation.id]);
  useEffect(() => {
    if (storedDraft.replyToId === null) {
      setReply(null);
      setReplyLoading(false);
    }
  }, [storedDraft.replyToId]);
  useEffect(() => {
    const targetId = drafts.get(conversation.id)?.replyToId;
    if (!targetId) return;
    const current = ++replyVersion.current;
    setReplyLoading(true);
    void requestRef
      .current<{ message: ChatMessage }>(path + '/messages/' + targetId)
      .then(({ message }) => {
        if (alive.current && current === replyVersion.current) setReply(message);
      })
      .catch((error: Error) => {
        if (alive.current && current === replyVersion.current) {
          setReply(null);
          const previous = drafts.get(conversation.id);
          if (previous) drafts.set(conversation.id, { ...previous, replyToId: null });
          setError('Reply target unavailable: ' + error.message);
        }
      })
      .finally(() => {
        if (alive.current && current === replyVersion.current) setReplyLoading(false);
      });
    return () => {
      replyVersion.current++;
    };
  }, [conversation.id, drafts, path]);
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
    void synchronize();
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
    } else void jump(navigation.messageId);
  }, [navigation, path, jump, drafts, conversation.id]);
  useEffect(() => {
    if (!socket) return;
    const join = () =>
      socket.emit('conversation:join', { conversationId: conversation.id }, (ack) => {
        if (ack.ok) void synchronize();
        else if (alive.current) {
          setError(ack.error);
          if ([401, 403, 404].includes(ack.status)) onAccessLost(conversation.id);
        }
      });
    const changed = (data: { conversationId: string }) => {
      if (data.conversationId === conversation.id) void synchronize();
    };
    const unavailable = () =>
      setError('Chat updates are temporarily unavailable. Your draft is retained; retry sync.');
    socket.on('connect', join);
    socket.on('conversation:changed', changed);
    socket.on('chat:unavailable', unavailable);
    if (socket.connected) join();
    const focus = () => void synchronize();
    window.addEventListener('focus', focus);
    return () => {
      socket.off('connect', join);
      socket.off('conversation:changed', changed);
      socket.off('chat:unavailable', unavailable);
      window.removeEventListener('focus', focus);
    };
  }, [socket, conversation.id, synchronize, onAccessLost]);
  useEffect(() => {
    if (!loading && loaded.current && !olderBusy && pinned.current)
      bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [items.length, loading]);
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
      !draft.trim() ||
      sending ||
      conversation.archived ||
      replyLoading ||
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
    setError('');
    drafts.set(conversation.id, { ...stored, attempt: pending });
    try {
      const message = await deliverMessage(requestRef.current, socket, conversation.id, pending);
      const current = drafts.get(conversation.id);
      const unchanged =
        current?.body === pending.body &&
        current.replyToId === pending.replyToId &&
        encodeChannelReferences(current.body, current.references) ===
          (pending.wireBody ?? pending.body) &&
        current.attempt?.clientId === pending.clientId;
      if (unchanged) drafts.delete(conversation.id);
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, [message], !historyRef.current).slice(-500));
        if (unchanged) {
          setReply(null);
          setPanel(null);
        }
        void synchronize();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function sendGif(url: string) {
    if (sending || conversation.archived || replyLoading)
      throw new Error('Wait for the current send, or choose an active conversation.');
    const stored = drafts.get(conversation.id) ?? emptyDraft;
    const pending = attemptFor({
      body: url,
      replyToId: stored.replyToId,
      attempt: drafts.mediaAttempts.get(conversation.id) ?? null,
    });
    drafts.mediaAttempts.set(conversation.id, pending);
    setSending(true);
    try {
      const message = await deliverMessage(requestRef.current, socket, conversation.id, pending);
      if (drafts.mediaAttempts.get(conversation.id)?.clientId === pending.clientId)
        drafts.mediaAttempts.delete(conversation.id);
      if (alive.current) {
        setItems((previous) => mergeMessages(previous, [message], !historyRef.current).slice(-500));
        void synchronize();
      }
    } finally {
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
      void jump(id);
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
          onClick={() => void jump(null)}
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
                      onClick={() => void older()}
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
              <button onClick={() => void synchronize()}>Retry sync</button>
            </div>
          )}
          <div className="composer-wrap">
            <ChatComposer
              body={draft}
              onChange={changeDraft}
              onSend={(event) => void send(event)}
              onSendGif={sendGif}
              reply={reply}
              replyLoading={replyLoading}
              onCancelReply={cancelReply}
              disabled={conversation.archived || (panel?.kind === 'thread' && !reply)}
              sending={sending}
              retrying={
                storedDraft.attempt?.body === draft &&
                storedDraft.attempt?.replyToId === storedDraft.replyToId
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
              <button type="button" className="jump-latest" onClick={() => void latest()}>
                Jump to latest messages
              </button>
            )}
            <div className="composer-footer">
              <span>
                {sending
                  ? 'Saving…'
                  : draft.length
                    ? draft.length + '/4000 · Enter to send · Shift+Enter for a new line'
                    : '@ to mention · /gif for GIFs · Enter to send'}
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
