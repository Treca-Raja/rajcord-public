import { runInBackground } from '../shared/background';
import type { ChannelCategory, Conversation, Invitation } from '@tricord/shared';
import { Avatar } from '@tricord/ui';
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Radio,
  Search,
  Settings,
  Sparkles,
  Users,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { useAuth } from './Auth';
import { SoundControls } from '../features/sounds';
import { VoiceFeature } from './VoiceFeature';
import { ScreenLauncher } from '../features/screen-sharing';
import type { VoiceChannel, VoiceSessionDock } from '../features/voice';
import { EmojiText } from '../shared/emoji/EmojiText';

type WorkspaceView = 'channels' | 'direct';

export function CommunitySidebar({
  membersOpen,
  categories,
  conversations,
  selected,
  view,
  choose,
  openDialog,
  invites,
  busy,
  action,
  connected,
  onlineIds,
  voiceSession,
  onInviteAccepted,
  setVoiceChannels,
  setVoiceSession,
  voiceNavigation,
}: {
  membersOpen: boolean;
  categories: ChannelCategory[];
  conversations: Conversation[];
  selected: string | null;
  view: WorkspaceView;
  choose: (id: string) => void;
  openDialog: (mode: 'channel' | 'dm' | 'group' | 'categories') => void;
  invites: Invitation[];
  busy: boolean;
  action: (work: () => Promise<unknown>) => Promise<void>;
  connected: boolean;
  onlineIds: string[];
  voiceSession: VoiceSessionDock | null;
  onInviteAccepted: (conversationId: string) => void;
  setVoiceChannels: (channels: VoiceChannel[]) => void;
  setVoiceSession: (session: VoiceSessionDock | null) => void;
  voiceNavigation: { id: string; version: number } | null;
}) {
  const { state, request, openSettings } = useAuth();
  return (
    <aside
      className="sidebar"
      id="community-sidebar"
      aria-label={view === 'channels' ? 'Channels' : 'Direct Messages'}
      inert={membersOpen}
    >
      <div className="community">
        <div>
          <strong>
            {view === 'channels' ? (
              <>
                Rajcord<span>.</span>
              </>
            ) : (
              'Direct Messages'
            )}
          </strong>
          {view === 'direct' && <small>PRIVATE CONVERSATIONS</small>}
        </div>
        {view === 'channels' ? (
          <ChevronDown size={16} aria-hidden="true" />
        ) : (
          <button aria-label="Start a direct message" onClick={() => openDialog('dm')}>
            <Plus size={17} />
          </button>
        )}
      </div>

      {view === 'channels' ? (
        <>
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
                    (conversation) =>
                      conversation.kind === 'channel' &&
                      (conversation.category?.id ?? null) === (category?.id ?? null),
                  )
                  .map((conversation) => (
                    <button
                      key={conversation.id}
                      className={
                        (selected === conversation.id ? 'selected ' : '') +
                        (conversation.unreadCount ? 'has-unread' : '')
                      }
                      data-conversation-id={conversation.id}
                      onClick={() => choose(conversation.id)}
                    >
                      <Hash size={18} />
                      <span className="truncate">
                        <EmojiText text={conversation.name} />
                      </span>
                      {conversation.unreadCount > 0 && (
                        <span
                          className="unread-badge"
                          aria-label={conversation.unreadCount + ' unread messages'}
                        >
                          {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                        </span>
                      )}
                      {conversation.mentionCount > 0 && (
                        <span
                          className="mention-badge"
                          aria-label={conversation.mentionCount + ' unread mentions'}
                        >
                          @{conversation.mentionCount}
                        </span>
                      )}
                      {conversation.archived && <small>Archived</small>}
                    </button>
                  ))}
              </section>
            ))}
          </div>
          <SoundControls />
        </>
      ) : (
        <>
          <button
            className="dm-search"
            aria-label="Find or start a conversation"
            onClick={() => openDialog('dm')}
          >
            <Search size={16} />
            <span>Find or start a conversation</span>
          </button>
          <div className="section-label">
            DIRECT MESSAGES
            <button aria-label="Create group" onClick={() => openDialog('group')}>
              <Plus size={15} />
            </button>
          </div>
          <div className="channels direct-message-list">
            {conversations
              .filter((conversation) => conversation.kind !== 'channel')
              .map((conversation) => {
                const peer =
                  conversation.kind === 'dm'
                    ? conversation.members.find((member) => member.id !== state.user.id)
                    : null;
                return (
                  <button
                    key={conversation.id}
                    className={
                      (selected === conversation.id ? 'selected ' : '') +
                      (conversation.unreadCount ? 'has-unread' : '')
                    }
                    data-conversation-id={conversation.id}
                    onClick={() => choose(conversation.id)}
                  >
                    {conversation.kind === 'group' ? (
                      <Users size={18} />
                    ) : (
                      <span className="conversation-avatar">
                        <Avatar>{(peer?.displayName ?? conversation.name).slice(0, 1)}</Avatar>
                        {peer && onlineIds.includes(peer.id) && <i aria-label="Online" />}
                      </span>
                    )}
                    <span className="truncate">
                      <EmojiText text={conversation.name} />
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span
                        className="unread-badge"
                        aria-label={conversation.unreadCount + ' unread messages'}
                      >
                        {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                      </span>
                    )}
                    {conversation.mentionCount > 0 && (
                      <span
                        className="mention-badge"
                        aria-label={conversation.mentionCount + ' unread mentions'}
                      >
                        @{conversation.mentionCount}
                      </span>
                    )}
                  </button>
                );
              })}
            {!conversations.some((conversation) => conversation.kind !== 'channel') && (
              <p className="direct-message-empty">Your direct conversations will appear here.</p>
            )}
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
                      runInBackground(
                        action(async () => {
                          await request('/invitations/' + invite.id, 'POST', { accept: true });
                          onInviteAccepted(invite.conversationId);
                        }),
                      )
                    }
                  >
                    Accept
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      runInBackground(
                        action(() =>
                          request('/invitations/' + invite.id, 'POST', { accept: false }),
                        ),
                      )
                    }
                  >
                    Decline
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <VoiceFeature
        showDirectory={view === 'channels'}
        onChannels={setVoiceChannels}
        onSession={setVoiceSession}
        requestedChannel={voiceNavigation}
      />

      <div className="grow" />
      <div className="sidebar-dock">
        {voiceSession && (
          <section className="voice-dock" aria-label="Voice connection">
            <div className="voice-dock-header">
              <span className="voice-dock-icon" aria-hidden="true">
                <Radio size={20} />
              </span>
              <div className="voice-dock-label">
                <strong>
                  {voiceSession.status === 'connected'
                    ? 'Voice Connected'
                    : voiceSession.status === 'joining'
                      ? 'Joining voice…'
                      : 'Reconnecting…'}
                </strong>
                <small>{voiceSession.channelName} / Rajcord</small>
              </div>
              <button
                className="voice-dock-leave"
                aria-label="Leave voice"
                title="Leave voice"
                onClick={voiceSession.leave}
              >
                <PhoneOff size={17} />
              </button>
            </div>
            <div className="voice-dock-actions" role="group" aria-label="More voice features">
              <button disabled title="Camera controls are coming soon" aria-label="Camera off">
                <VideoOff size={18} />
              </button>
              <ScreenLauncher />
              <button disabled title="Activities are coming soon" aria-label="Activities">
                <Sparkles size={18} />
              </button>
              <button disabled title="Soundboard is coming soon" aria-label="Soundboard">
                <Volume2 size={18} />
              </button>
            </div>
          </section>
        )}
        <div className="profile">
          <span className="profile-avatar">
            <Avatar>{state.user.displayName.slice(0, 1)}</Avatar>
            <i className={connected ? 'online' : 'offline'} aria-hidden="true" />
          </span>
          <div className="profile-identity">
            <strong>{state.user.displayName}</strong>
            <small className={voiceSession ? 'in-voice' : ''}>
              {voiceSession && <Volume2 size={12} aria-hidden="true" />}
              {voiceSession ? 'In voice' : connected ? 'Online' : 'Offline'}
            </small>
          </div>
          <div className="profile-audio-controls" role="group" aria-label="Voice controls">
            <button
              className="profile-control"
              aria-label={voiceSession?.muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={voiceSession?.muted ?? false}
              title={voiceSession ? 'Toggle microphone' : 'Join voice to use microphone'}
              disabled={!voiceSession}
              onClick={() => voiceSession?.toggleMute()}
            >
              {voiceSession?.muted ? <MicOff size={17} /> : <Mic size={17} />}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <button
              className="profile-control"
              aria-label={voiceSession?.deafened ? 'Enable audio' : 'Deafen'}
              aria-pressed={voiceSession?.deafened ?? false}
              title={voiceSession ? 'Toggle audio' : 'Join voice to control audio'}
              disabled={!voiceSession}
              onClick={() => voiceSession?.toggleDeafen()}
            >
              <Headphones size={17} />
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </div>
          <button
            className="profile-settings"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings()}
          >
            <Settings size={19} />
          </button>
        </div>
      </div>
    </aside>
  );
}
