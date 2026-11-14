import { MemberPanel } from './MemberPanel';
import { usePresence } from './use-presence';
import { Notifications } from './Notifications';
import { Messages } from './Messages';
import { DraftStore } from './chat-state';
import { CategoryManager, ChannelFields, ChannelSettings } from './Channels';
import { channelCategories, channelFields } from './channel-state';
import { ApplicationSounds } from './ApplicationSounds';
import { CommunitySidebar } from './CommunitySidebar';
import { useCallback, useMemo, useEffect, useRef, useState, type FormEvent } from 'react';
import { Hash, Users, Settings, MessageCircle, Menu, X } from 'lucide-react';
import type {
  Conversation,
  Invitation,
  AuthUser,
  ConversationUnread,
  ChannelCategoryPage,
  NotificationTarget,
  ChannelReference,
} from '@tricord/shared';
import { AuthRoot, useAuth } from './Auth';
import type { VoiceChannel } from './voice-controller';
import { EmojiText } from './EmojiText';
import { AppearanceBrand, AppearanceToggle } from './Appearance';
import './auth.css';
import './chat.css';
import type { ScreenApplication } from './screen-application';
import { ScreenPanel } from './ScreenPanel';
export function App({ screenApplication }: { screenApplication?: ScreenApplication } = {}) {
  return (
    <AuthRoot screenApplication={screenApplication}>
      <AccountCommunity />
    </AuthRoot>
  );
}
function AccountCommunity() {
  const { state } = useAuth();
  return (
    <ApplicationSounds key={state.user.id} userId={state.user.id}>
      <Community key={state.user.id} />
    </ApplicationSounds>
  );
}
function Community() {
  const { state, connected, socket, request, openSettings } = useAuth();
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
  const [membersOpen, setMembersOpen] = useState(false);
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const presence = usePresence(socket);
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
    setRosterAvailable(false);
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
      setRosterAvailable(true);
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
      if (version !== reloadVersion.current) return;
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        setConversations([]);
        setInvites([]);
        setMembers([]);
        setSelected(null);
        setModal(null);
      }
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
  }, [reload, presence.rosterVersion]);
  useEffect(() => {
    if (!socket) return;
    const changed = () => void reload();
    const closed = ({ conversationId }: { conversationId: string }) => {
      closeConversation(conversationId);
      setInvites((previous) =>
        previous.filter((invite) => invite.conversationId !== conversationId),
      );
      setModal(null);
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
    socket.on('account:changed', changed);
    socket.on('connect', changed);
    socket.on('conversation:closed', closed);
    window.addEventListener('focus', changed);
    return () => {
      socket.off('unread:changed', unreadChanged);
      socket.off('inbox:changed', changed);
      socket.off('account:changed', changed);
      socket.off('connect', changed);
      socket.off('conversation:closed', closed);
      window.removeEventListener('focus', changed);
    };
  }, [socket, reload, closeConversation]);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1201px)');
    const resize = () => {
      if (wide.matches) setMembersOpen(false);
    };
    wide.addEventListener('change', resize);
    return () => wide.removeEventListener('change', resize);
  }, []);
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
      <nav className="rail" aria-label="Platform" inert={membersOpen}>
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
      <CommunitySidebar
        membersOpen={membersOpen}
        categories={categories}
        conversations={conversations}
        selected={selected}
        choose={choose}
        openDialog={openDialog}
        invites={invites}
        busy={busy}
        action={action}
        setSelected={setSelected}
        setVoiceChannels={setVoiceChannels}
        voiceNavigation={voiceNavigation}
      />
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
      <section className="chat" inert={membersOpen}>
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
          <button
            className="members-action"
            aria-label="Members"
            aria-expanded={membersOpen}
            onClick={() => setMembersOpen(true)}
          >
            <Users size={18} />
          </button>
          {current && (
            <button aria-label="Manage conversation" onClick={() => openDialog('manage')}>
              <Settings size={18} />
            </button>
          )}
        </header>
        <ScreenPanel />
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
            readingAllowed={!mobile && !modal && !membersOpen}
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
      <MemberPanel
        key={current?.id ?? 'community'}
        conversation={current}
        members={members}
        rosterAvailable={rosterAvailable}
        snapshot={presence.snapshot}
        connected={connected}
        userId={state.user.id}
        drawer={membersOpen}
        close={() => setMembersOpen(false)}
        settings={() => openSettings('people')}
        retry={() => {
          presence.retry();
          void reload();
        }}
        contact={(id) => {
          setMembersOpen(false);
          if (id !== state.user.id)
            void action(async () => {
              const data = await request<{ conversation: Conversation }>('/conversations', 'POST', {
                kind: 'dm',
                userId: id,
              });
              setSelected(data.conversation.id);
            });
        }}
      />
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
