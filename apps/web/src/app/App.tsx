import { runInBackground } from '../shared/background';
import { MemberPanel } from '../features/presence';
import { usePresence } from '../features/presence';
import { Notifications } from '../features/notifications';
import { Messages } from '../features/chat';
import { DraftStore, newConversationFields } from '../features/chat';
import { ConversationDialog, type ConversationDialogMode } from './ConversationDialog';
import { channelCategories, channelFields } from '../features/channels';
import { ApplicationSounds } from '../features/sounds';
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
import type { VoiceChannel, VoiceSessionDock } from '../features/voice';
import { EmojiText } from '../shared/emoji/EmojiText';
import { AppearanceBrand } from '../features/appearance';
import '../features/account/styles.css';
import './shell.css';
import type { ScreenApplication } from '../features/screen-sharing';
import { ScreenFeature } from './ScreenFeature';
import { FeatureBoundary } from '../shared/FeatureBoundary';
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
  const [workspaceView, setWorkspaceView] = useState<'channels' | 'direct'>('channels');
  const workspaceViewRef = useRef<'channels' | 'direct'>('channels');
  const lastChannelId = useRef<string | null>(null);
  const lastDirectId = useRef<string | null>(null);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionDock | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState(''),
    [modal, setModal] = useState<ConversationDialogMode | null>(null),
    [busy, setBusy] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const dialogTrigger = useRef<HTMLElement | null>(null);
  function openDialog(mode: NonNullable<typeof modal>, trigger?: HTMLElement) {
    dialogTrigger.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setError('');
    setModal(mode);
  }
  function rememberConversation(conversation: Conversation) {
    if (conversation.kind === 'channel') lastChannelId.current = conversation.id;
    else lastDirectId.current = conversation.id;
  }
  function selectConversation(conversation: Conversation) {
    const view = conversation.kind === 'channel' ? 'channels' : 'direct';
    workspaceViewRef.current = view;
    setWorkspaceView(view);
    rememberConversation(conversation);
    setSelected(conversation.id);
    setNavigation(null);
    setMobile(false);
    setError('');
  }
  function selectDirectConversationId(conversationId: string) {
    workspaceViewRef.current = 'direct';
    setWorkspaceView('direct');
    lastDirectId.current = conversationId;
    setSelected(conversationId);
    setMobile(false);
  }
  function switchWorkspaceView(view: 'channels' | 'direct') {
    if (view === workspaceViewRef.current) {
      if (window.innerWidth <= 750) setMobile((open) => !open);
      return;
    }
    workspaceViewRef.current = view;
    setWorkspaceView(view);
    const belongs = (conversation: Conversation) =>
      view === 'channels' ? conversation.kind === 'channel' : conversation.kind !== 'channel';
    const rememberedId = view === 'channels' ? lastChannelId.current : lastDirectId.current;
    const target =
      conversations.find((conversation) => conversation.id === selected && belongs(conversation)) ??
      conversations.find(
        (conversation) => conversation.id === rememberedId && belongs(conversation),
      ) ??
      conversations.find((conversation) => belongs(conversation) && !conversation.archived);
    if (target) {
      rememberConversation(target);
      setSelected(target.id);
    } else setSelected(null);
    setNavigation(null);
    setError('');
    setMobile(window.innerWidth <= 750);
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
      const view = workspaceViewRef.current;
      const belongs = (conversation: Conversation) =>
        view === 'channels' ? conversation.kind === 'channel' : conversation.kind !== 'channel';
      const rememberedId = view === 'channels' ? lastChannelId.current : lastDirectId.current;
      setSelected((current) => {
        const target =
          data.conversations.find(
            (conversation) => conversation.id === current && belongs(conversation),
          ) ??
          data.conversations.find(
            (conversation) => conversation.id === rememberedId && belongs(conversation),
          ) ??
          data.conversations.find(
            (conversation) => belongs(conversation) && !conversation.archived,
          );
        return target?.id ?? null;
      });
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
      runInBackground(reload());
    },
    [reload],
  );
  useEffect(() => {
    runInBackground(reload());
  }, [reload, presence.rosterVersion]);
  useEffect(() => {
    if (!socket) return;
    const changed = () => runInBackground(reload());
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
  const current = conversations.find(
    (conversation) =>
      conversation.id === selected &&
      (workspaceView === 'channels'
        ? conversation.kind === 'channel'
        : conversation.kind !== 'channel'),
  );
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
      workspaceViewRef.current = 'channels';
      setWorkspaceView('channels');
      lastChannelId.current = channel.id;
      setSelected(channel.id);
      setNavigation(null);
      setMobile(false);
    } else {
      workspaceViewRef.current = 'channels';
      setWorkspaceView('channels');
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
      const bounds = previous?.getBoundingClientRect();
      const sidebar = previous?.closest('.sidebar');
      const mobileSidebarClosed = Boolean(
        sidebar &&
        innerWidth <= 750 &&
        !sidebar.closest('.shell')?.classList.contains('mobile-open'),
      );
      if (
        previous?.isConnected &&
        !mobileSidebarClosed &&
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.bottom > 0 &&
        bounds.right > 0 &&
        bounds.top < innerHeight &&
        bounds.left < innerWidth &&
        getComputedStyle(previous).visibility === 'visible'
      )
        previous.focus();
      else document.querySelector<HTMLTextAreaElement>('textarea[name=message]')?.focus();
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
  async function create(event: FormEvent<HTMLFormElement>, kind: Conversation['kind']) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await action(async () => {
      const body =
        kind === 'channel'
          ? { kind: 'channel', ...channelFields(data) }
          : newConversationFields(kind, data);
      const result = await request<{ conversation: Conversation }>('/conversations', 'POST', body);
      selectConversation(result.conversation);
      setModal(null);
    });
  }
  const choose = (id: string) => {
    const conversation = conversations.find((item) => item.id === id);
    if (conversation) selectConversation(conversation);
  };
  return (
    <div className={'shell live-shell' + (mobile ? ' mobile-open' : '')}>
      <nav className="rail" aria-label="Primary navigation" inert={membersOpen}>
        <AppearanceBrand />
        <div className="rail-rule" />
        <button
          className={workspaceView === 'channels' ? 'rail-active' : ''}
          aria-label="Channels"
          aria-pressed={workspaceView === 'channels'}
          title="Channels"
          onClick={() => switchWorkspaceView('channels')}
        >
          <Hash />
        </button>
        <button
          className={workspaceView === 'direct' ? 'rail-active' : ''}
          aria-label="Direct Messages"
          aria-pressed={workspaceView === 'direct'}
          title="Direct Messages"
          onClick={() => switchWorkspaceView('direct')}
        >
          <MessageCircle />
        </button>
        <div className="grow" />
      </nav>
      <CommunitySidebar
        membersOpen={membersOpen}
        categories={categories}
        conversations={conversations}
        selected={selected}
        view={workspaceView}
        choose={choose}
        openDialog={openDialog}
        invites={invites}
        busy={busy}
        action={action}
        connected={connected}
        onlineIds={presence.snapshot?.onlineIds ?? []}
        voiceSession={voiceSession}
        onInviteAccepted={selectDirectConversationId}
        setVoiceChannels={setVoiceChannels}
        setVoiceSession={setVoiceSession}
        voiceNavigation={voiceNavigation}
      />
      <Notifications
        key={state.user.id}
        selected={selected}
        onOpen={(target) => {
          const conversation = conversations.find((item) => item.id === target.conversationId);
          if (conversation) selectConversation(conversation);
          else runInBackground(reload());
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
          {workspaceView === 'channels' ? <Hash size={23} /> : <MessageCircle size={23} />}
          <strong className="truncate">
            <EmojiText
              text={
                current?.name ?? (workspaceView === 'channels' ? 'Channels' : 'Direct Messages')
              }
            />
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
            <button
              aria-label="Manage conversation"
              onClick={(event) => openDialog('manage', event.currentTarget)}
            >
              <Settings size={18} />
            </button>
          )}
        </header>
        <ScreenFeature />
        {error && (
          <div className="notice" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {current ? (
          <FeatureBoundary key={current.id} name="Messages">
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
          </FeatureBoundary>
        ) : (
          <div className="empty-channel">
            {workspaceView === 'channels' ? <Hash size={34} /> : <MessageCircle size={34} />}
            <h1>
              {workspaceView === 'channels' ? 'Your channels are here.' : 'Your DMs are here.'}
            </h1>
            <p>
              {workspaceView === 'channels'
                ? 'Create a channel to start a conversation with your community.'
                : 'Start a private conversation or create a group with your friends.'}
            </p>
            <button
              className="primary"
              onClick={(event) =>
                openDialog(workspaceView === 'channels' ? 'channel' : 'dm', event.currentTarget)
              }
            >
              {workspaceView === 'channels' ? 'Create a channel' : 'Start a direct message'}
            </button>
            {workspaceView === 'direct' && (
              <button
                className="text-button"
                onClick={(event) => openDialog('group', event.currentTarget)}
              >
                Create a group
              </button>
            )}
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
          runInBackground(reload());
        }}
        contact={(id) => {
          setMembersOpen(false);
          if (id !== state.user.id)
            runInBackground(
              action(async () => {
                const data = await request<{ conversation: Conversation }>(
                  '/conversations',
                  'POST',
                  {
                    kind: 'dm',
                    userId: id,
                  },
                );
                selectConversation(data.conversation);
              }),
            );
        }}
      />
      {modal && (
        <ConversationDialog
          modal={modal}
          current={current}
          categories={categories}
          members={members}
          error={error}
          busy={busy}
          reload={reload}
          create={create}
          openDialog={openDialog}
          setModal={setModal}
          action={action}
          nextCategoryPage={categoryPage.nextAfter}
          categoriesBusy={categoriesBusy}
          moreCategories={moreCategories}
        />
      )}
    </div>
  );
}
