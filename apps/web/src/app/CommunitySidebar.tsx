import { runInBackground } from '../shared/background';
import type { ChannelCategory, Conversation, Invitation } from '@tricord/shared';
import { Avatar } from '@tricord/ui';
import {
  Hash,
  Users,
  Settings,
  Plus,
  MessageCircle,
  ChevronDown,
  ShieldCheck,
  LogOut,
  FolderPlus,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from './Auth';
import { SoundControls } from '../features/sounds';
import { VoiceFeature } from './VoiceFeature';
import type { VoiceChannel } from '../features/voice';
import { EmojiText } from '../shared/emoji/EmojiText';

export function CommunitySidebar({
  membersOpen,
  categories,
  conversations,
  selected,
  choose,
  openDialog,
  invites,
  busy,
  action,
  setSelected,
  setVoiceChannels,
  voiceNavigation,
}: {
  membersOpen: boolean;
  categories: ChannelCategory[];
  conversations: Conversation[];
  selected: string | null;
  choose: (id: string) => void;
  openDialog: (mode: 'channel' | 'dm' | 'group' | 'categories') => void;
  invites: Invitation[];
  busy: boolean;
  action: (work: () => Promise<unknown>) => Promise<void>;
  setSelected: (id: string) => void;
  setVoiceChannels: (channels: VoiceChannel[]) => void;
  voiceNavigation: { id: string; version: number } | null;
}) {
  const { state, request, openSettings, logout } = useAuth();
  return (
    <aside className="sidebar" id="community-sidebar" aria-label="Community" inert={membersOpen}>
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
                (c) => c.kind === 'channel' && (c.category?.id ?? null) === (category?.id ?? null),
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
                    <span className="unread-badge" aria-label={c.unreadCount + ' unread messages'}>
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
                  runInBackground(
                    action(async () => {
                      await request('/invitations/' + invite.id, 'POST', { accept: true });
                      setSelected(invite.conversationId);
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
                    action(() => request('/invitations/' + invite.id, 'POST', { accept: false })),
                  )
                }
              >
                Decline
              </button>
            </div>
          ))}
        </div>
      )}
      <SoundControls />
      <VoiceFeature onChannels={setVoiceChannels} requestedChannel={voiceNavigation} />
      <div className="grow" />
      <div className="profile">
        <Avatar>{state.user.displayName.slice(0, 1)}</Avatar>
        <div>
          <strong>{state.user.displayName}</strong>
          <small>{state.user.isOwner ? 'Platform owner' : 'Member · administrator'}</small>
        </div>
        <button aria-label="Sign out" title="Sign out" onClick={() => runInBackground(logout())}>
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
  );
}
