import { runInBackground } from '../shared/background';
import type { ChannelCategory, Conversation, Invitation } from '@tricord/shared';
import { Avatar } from '@tricord/ui';
import { X, FolderPlus, Hash, Plus, MessageCirclePlus, Users } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { AppearanceBrand } from '../features/appearance';
import { useAuth } from './Auth';
import { SoundControls } from '../features/sounds';
import { VoiceFeature } from './VoiceFeature';
import { VoiceDock } from './VoiceDock';
import type { VoiceChannel, VoiceSessionDock } from '../features/voice';
import { EmojiText } from '../shared/emoji/EmojiText';

import { NavigationSectionHeader } from '../shared/NavigationSection';

export function CommunitySidebar({
  membersOpen,
  mobileOpen,
  onCloseNavigation,
  categories,
  conversations,
  selected,
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
  mobileOpen: boolean;
  onCloseNavigation: () => void;
  categories: ChannelCategory[];
  conversations: Conversation[];
  selected: string | null;
  choose: (id: string) => void;
  openDialog: (mode: 'channel' | 'dm' | 'group' | 'categories', trigger?: HTMLElement) => void;
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
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [messagesOpen, setMessagesOpen] = useState(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!mobileOpen) return;
    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [mobileOpen]);
  return (
    <aside
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen || undefined}
      onKeyDown={(event) => {
        if (!mobileOpen) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onCloseNavigation();
        }
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), summary, input:not(:disabled)',
          ),
        ].filter((element) => element.checkVisibility());
        if (event.shiftKey && document.activeElement === controls[0]) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
          event.preventDefault();
          controls[0]?.focus();
        }
      }}
      className="sidebar"
      id="community-sidebar"
      aria-label="Workspace navigation"
      inert={membersOpen}
    >
      <div className="community">
        <div className="workspace-brand">
          <AppearanceBrand />
          <strong>Rajcord</strong>
        </div>
        {mobileOpen && (
          <button ref={closeButton} aria-label="Close navigation" onClick={onCloseNavigation}>
            <X size={18} />
          </button>
        )}
      </div>
      <nav className="workspace-sections" aria-label="Conversations and voice">
        <section>
          <NavigationSectionHeader
            label="Channels"
            controls="navigation-channels"
            expanded={channelsOpen}
            onToggle={() => setChannelsOpen(!channelsOpen)}
          >
            <button
              aria-label="Manage categories"
              title="Manage categories"
              onClick={(event) => openDialog('categories', event.currentTarget)}
            >
              <FolderPlus size={15} aria-hidden="true" />
            </button>
            <button
              aria-label="Create channel"
              title="Create channel"
              onClick={(event) => openDialog('channel', event.currentTarget)}
            >
              <Plus size={15} />
            </button>
          </NavigationSectionHeader>
          <div id="navigation-channels" hidden={!channelsOpen} className="channels">
            {[...categories, null].map((category) => (
              <section
                key={category?.id ?? 'uncategorized'}
                className="channel-category"
                data-category-id={category?.id ?? 'uncategorized'}
                aria-label={category?.name ?? 'Uncategorized'}
              >
                {(category || categories.length > 0) && (
                  <h2 className="category-heading">{category?.name ?? 'Uncategorized'}</h2>
                )}
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
                      aria-current={selected === conversation.id ? 'page' : undefined}
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
        </section>
        <VoiceFeature
          directoryTools={<SoundControls />}
          onChannels={setVoiceChannels}
          onSession={setVoiceSession}
          requestedChannel={voiceNavigation}
        />
        <section>
          <NavigationSectionHeader
            label="Direct messages"
            controls="navigation-direct"
            expanded={messagesOpen}
            onToggle={() => setMessagesOpen(!messagesOpen)}
          >
            <button
              aria-label="Find or start a conversation"
              title="Start a direct message"
              onClick={(event) => openDialog('dm', event.currentTarget)}
            >
              <MessageCirclePlus size={15} />
            </button>
            <button
              aria-label="Create group"
              title="Create group"
              onClick={(event) => openDialog('group', event.currentTarget)}
            >
              <Plus size={15} />
            </button>
          </NavigationSectionHeader>
          <div
            id="navigation-direct"
            hidden={!messagesOpen}
            className="channels direct-message-list"
          >
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
                    aria-current={selected === conversation.id ? 'page' : undefined}
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
              <p className="direct-message-empty">No conversations yet.</p>
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
        </section>
      </nav>
      <div className="grow" />
      <VoiceDock
        voiceSession={voiceSession}
        connected={connected}
        displayName={state.user.displayName}
        onSettings={() => openSettings()}
      />
    </aside>
  );
}
