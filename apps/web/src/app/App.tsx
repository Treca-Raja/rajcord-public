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
import { MobileVoiceControls } from './VoiceDock';
import {
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Hash, ChevronDown, Settings, MessageCircle, Menu, X } from 'lucide-react';
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
import { ConversationSwitcher } from './ConversationSwitcher';
import { StreamActivity, ActivityButton } from './StreamActivity';
import '../features/account/styles.css';
import './shell.css';
import type { ScreenApplication } from '../features/screen-sharing';
import { ScreenFeature } from './ScreenFeature';
import { FeatureBoundary } from '../shared/FeatureBoundary';
import { useCall } from '../shared/call';
const noScreenSubscription = () => () => {};
const noScreenSnapshot = () => false;
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
  const call = useCall();
  const [callChatVisible, setCallChatVisible] = useState(false);
  const screenOpen = useSyncExternalStore(
    call?.screens?.subscribe ?? noScreenSubscription,
    () => call?.screens?.inspect().open ?? false,
    noScreenSnapshot,
  );
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
  const [activityPinned, setActivityPinned] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1201px)').matches);
  const activityVisible = !screenOpen && (wide ? activityPinned : membersOpen);
  const activityTrigger = useRef<HTMLButtonElement>(null);
  const callReturnFocus = useRef<'activity' | 'navigation' | null>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const mobileCallTrigger = useRef<HTMLButtonElement>(null);
  function dismissActivity() {
    if (wide) setActivityPinned(false);
    else setMembersOpen(false);
  }
  function closeActivity() {
    dismissActivity();
    requestAnimationFrame(() => activityTrigger.current?.focus({ preventScroll: true }));
  }
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const presence = usePresence(socket);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionDock | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState(''),
    [modal, setModal] = useState<ConversationDialogMode | null>(null),
    [busy, setBusy] = useState(false);
  const current = conversations.find((conversation) => conversation.id === selected);
  const currentId = current?.id;
  const directory = current?.kind === 'channel' ? 'channels' : 'direct';
  const lastVisited = useRef<Partial<Record<'channels' | 'direct', string>>>({});
  useLayoutEffect(() => {
    if (currentId) lastVisited.current[directory] = currentId;
  }, [currentId, directory]);
  const [switcherOrder, setSwitcherOrder] = useState<string[] | null>(null);
  const switcherOpen = switcherOrder !== null;
  const openSwitcher = useCallback(() => {
    const other = lastVisited.current[directory === 'channels' ? 'direct' : 'channels'];
    setSwitcherOrder([other, currentId].filter((id): id is string => !!id));
  }, [currentId, directory]);

  useEffect(() => {
    if (screenOpen || membersOpen || modal || switcherOpen) return;
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'k' ||
        document.querySelector('[aria-modal="true"]:not(#community-sidebar), dialog[open]')
      )
        return;
      event.preventDefault();
      openSwitcher();
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [screenOpen, membersOpen, modal, switcherOpen, openSwitcher]);
  const requestRef = useRef(request);
  requestRef.current = request;
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const pendingCreatedConversationFocus = useRef<string | null>(null);
  function openDialog(mode: NonNullable<typeof modal>, trigger?: HTMLElement) {
    dialogTrigger.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setError('');
    setModal(mode);
  }
  function closeNavigation() {
    setMobile(false);
    requestAnimationFrame(() => navigationTrigger.current?.focus({ preventScroll: true }));
  }
  function selectConversation(conversation: Conversation) {
    setSelected(conversation.id);
    setNavigation(null);
    setMobile(false);
    setError('');
  }
  function selectDirectConversationId(conversationId: string) {
    setSelected(conversationId);
    setMobile(false);
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
      setSelected(
        (current) =>
          (
            data.conversations.find((conversation) => conversation.id === current) ??
            data.conversations.find(
              (conversation) => conversation.kind === 'channel' && !conversation.archived,
            ) ??
            data.conversations.find((conversation) => !conversation.archived)
          )?.id ?? null,
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
    const panelQuery = window.matchMedia('(min-width: 1201px)');
    const navQuery = window.matchMedia('(max-width: 750px)');
    const updatePanel = () => {
      setWide(panelQuery.matches);
      setMembersOpen(false);
    };
    const updateNav = () => setMobile(false);
    panelQuery.addEventListener('change', updatePanel);
    navQuery.addEventListener('change', updateNav);
    return () => {
      panelQuery.removeEventListener('change', updatePanel);
      navQuery.removeEventListener('change', updateNav);
    };
  }, []);
  const voiceStatus = call?.voice.status;
  useEffect(() => {
    if (screenOpen) {
      if (mobile) callReturnFocus.current = 'navigation';
      setMobile(false);
      setMembersOpen(false);
      return;
    }
    const origin = callReturnFocus.current;
    callReturnFocus.current = null;
    if (origin === 'activity') {
      activityTrigger.current?.focus({ preventScroll: true });
    } else if (origin === 'navigation') {
      const room = mobileCallTrigger.current;
      const target =
        voiceStatus !== 'idle' && room?.checkVisibility() && !room.disabled
          ? room
          : navigationTrigger.current;
      target?.focus({ preventScroll: true });
    }
  }, [mobile, screenOpen, voiceStatus]);
  const unreadTotal = conversations.reduce((total, c) => total + c.unreadCount, 0);
  useEffect(() => {
    document.title = (unreadTotal ? '(' + unreadTotal + ') ' : '') + 'Rajcord';
    return () => {
      document.title = 'Rajcord';
    };
  }, [unreadTotal]);
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
      if (window.innerWidth <= 750) setMobile(true);
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
  useLayoutEffect(() => {
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
  useEffect(() => {
    if (modal || !current || pendingCreatedConversationFocus.current !== current.id) return;
    const composer = document.querySelector<HTMLTextAreaElement>('.chat textarea[name="message"]');
    if (!composer || composer.disabled) return;
    composer.focus({ preventScroll: true });
    pendingCreatedConversationFocus.current = null;
  }, [modal, current]);
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
      pendingCreatedConversationFocus.current = result.conversation.id;
      selectConversation(result.conversation);
      setModal(null);
    });
  }
  const choose = (id: string, focusComposer = mobile) => {
    const conversation = conversations.find((item) => item.id === id);
    if (conversation) {
      selectConversation(conversation);
      if (focusComposer)
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLTextAreaElement>(
            '.live-composer textarea:not(:disabled)',
          );
          (input ?? document.querySelector<HTMLButtonElement>('.conversation-jump'))?.focus({
            preventScroll: true,
          });
        });
    }
  };
  return (
    <div
      className={
        'shell live-shell' +
        (mobile ? ' mobile-open' : '') +
        (screenOpen ? ' screen-call-open' : '') +
        (activityVisible && wide ? ' activity-pinned' : '')
      }
    >
      {mobile && (
        <div className="navigation-backdrop" onClick={closeNavigation} aria-hidden="true" />
      )}
      <CommunitySidebar
        membersOpen={membersOpen && !screenOpen}
        mobileOpen={mobile}
        onCloseNavigation={closeNavigation}
        categories={categories}
        conversations={conversations}
        selected={selected}
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
      <section className="chat" inert={(membersOpen || mobile) && !screenOpen}>
        <header className="channel-header">
          <button
            ref={navigationTrigger}
            className="mobile-menu header-action"
            aria-label="Toggle navigation"
            aria-controls="community-sidebar"
            aria-expanded={mobile}
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={20} />
          </button>
          <button
            className="conversation-jump"
            aria-haspopup="dialog"
            aria-label={'Switch conversation, ' + (current?.name ?? 'Conversations')}
            title="Switch conversation (Ctrl/Cmd+K)"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={openSwitcher}
          >
            {current?.kind === 'channel' ? <Hash size={20} /> : <MessageCircle size={20} />}
            <strong className="truncate">
              <EmojiText text={current?.name ?? 'Conversations'} />
            </strong>
            <ChevronDown size={14} />
          </button>
          {current?.kind === 'channel' && current.topic && (
            <span className="channel-topic">{current.topic}</span>
          )}
          <div className="grow" />
          <ActivityButton
            trigger={activityTrigger}
            expanded={activityVisible}
            onClick={() => (wide ? setActivityPinned(!activityPinned) : setMembersOpen(true))}
          />
          {current && (
            <button
              className="header-action"
              aria-label="Manage conversation"
              onClick={(event) => openDialog('manage', event.currentTarget)}
            >
              <Settings size={18} />
            </button>
          )}
        </header>
        <MobileVoiceControls
          voiceSession={voiceSession}
          callOpen={screenOpen}
          roomButton={mobileCallTrigger}
        />
        <ScreenFeature
          voiceChannels={voiceChannels}
          chatName={current?.name}
          onChatVisibleChange={setCallChatVisible}
        />
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
              readingAllowed={
                !mobile &&
                !modal &&
                !switcherOpen &&
                !membersOpen &&
                (!screenOpen || callChatVisible)
              }
              drafts={drafts.current}
              navigation={navigation?.conversationId === current.id ? navigation : null}
              onAccessLost={closeConversation}
              channels={channelReferences}
              onChannel={navigateChannel}
            />
          </FeatureBoundary>
        ) : (
          <div className="empty-channel">
            <MessageCircle size={32} />
            <h1>No conversations yet</h1>
            <button
              className="primary"
              onClick={(event) => openDialog('channel', event.currentTarget)}
            >
              Create a channel
            </button>
            <button
              className="text-button"
              onClick={(event) => openDialog('dm', event.currentTarget)}
            >
              Start a direct message
            </button>
          </div>
        )}
      </section>
      {switcherOrder && (
        <ConversationSwitcher
          priorityIds={switcherOrder}
          userId={state.user.id}
          conversations={conversations}
          onClose={() => setSwitcherOrder(null)}
          onChoose={(id) => {
            setSwitcherOrder(null);
            choose(id, true);
          }}
        />
      )}
      {activityVisible && (
        <MemberPanel
          key={current?.id ?? 'community'}
          conversation={current}
          members={members}
          rosterAvailable={rosterAvailable}
          snapshot={presence.snapshot}
          connected={connected}
          userId={state.user.id}
          drawer={membersOpen && !screenOpen}
          streamActivity={
            <StreamActivity
              onOpen={() => {
                callReturnFocus.current = 'activity';
              }}
            />
          }
          close={closeActivity}
          settings={() => {
            dismissActivity();
            openSettings('people', activityTrigger.current ?? undefined);
          }}
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
      )}
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
