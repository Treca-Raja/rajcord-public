import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';
import { Avatar } from '@tricord/ui';
import type { AuthUser, Conversation, PresenceSnapshot } from '@tricord/shared';
import { groupPresence, type RosterMember } from './presence-state';

export function MemberPanel({
  conversation,
  members,
  rosterAvailable,
  snapshot,
  connected,
  userId,
  drawer,
  close,
  contact,
  settings,
  retry,
}: {
  conversation?: Conversation;
  members: AuthUser[];
  rosterAvailable: boolean;
  snapshot: PresenceSnapshot | null;
  connected: boolean;
  userId: string;
  drawer: boolean;
  close: () => void;
  contact: (id: string) => void;
  settings: () => void;
  retry: () => void;
}) {
  const privateConversation = !!conversation && conversation.kind !== 'channel';
  const [view, setView] = useState<'participants' | 'community'>(
    privateConversation ? 'participants' : 'community',
  );
  const [offlineExpanded, setOfflineExpanded] = useState(true);
  const panel = useRef<HTMLElement>(null);
  const focusedMember = useRef<string | null>(null);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const member =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-member-id]')
          : null;
      if (!member || !panel.current?.contains(member)) focusedMember.current = null;
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) {
        focusedMember.current = null;
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', focus, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (focusedMember.current && document.activeElement === document.body) {
      const retained = [
        ...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-member-id]') ?? []),
      ].find((element) => element.dataset.memberId === focusedMember.current);
      if (retained && !retained.disabled) retained.focus();
      else if (rosterAvailable) focusedMember.current = null;
    }
  });
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const controls = panel.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      if (!controls?.length) return;
      const first = controls[0]!,
        last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [drawer]);
  const roster = rosterAvailable
    ? view === 'participants' && privateConversation
      ? conversation.members
      : members
    : [];
  const groups = groupPresence(roster, snapshot?.onlineIds ?? []);
  const ready = !!snapshot && rosterAvailable;
  function row(person: RosterMember, presence: string) {
    return (
      <button
        className="member member-button"
        key={person.id}
        data-member-id={person.id}
        data-presence={presence}
        onClick={() => contact(person.id)}
        disabled={person.id === userId || person.status !== 'approved'}
      >
        <Avatar>{person.displayName.slice(0, 1)}</Avatar>
        <div className="member-identity">
          <strong>{person.displayName}</strong>
          <small>
            @{person.username}
            {person.id === userId ? ' · You' : ''}
            {conversation?.managerId === person.id ? ' · Group manager' : ''}
          </small>
          <small className="member-presence">
            <i aria-hidden="true" className={'presence-dot ' + presence} />
            {presence === 'online' ? 'Online' : presence === 'offline' ? 'Offline' : 'Unavailable'}
          </small>
        </div>
      </button>
    );
  }
  return (
    <>
      {drawer && <div className="members-backdrop" onClick={close} aria-hidden="true" />}
      <aside
        ref={panel}
        onFocusCapture={(event) => {
          focusedMember.current =
            (event.target as HTMLElement).closest<HTMLElement>('[data-member-id]')?.dataset
              .memberId ?? null;
        }}
        onBlurCapture={(event) => {
          if (event.relatedTarget instanceof Node && !panel.current?.contains(event.relatedTarget))
            focusedMember.current = null;
        }}
        className={'members presence-panel' + (drawer ? ' members-drawer' : '')}
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer ? true : undefined}
        aria-label="Members"
        data-presence-state={ready ? 'ready' : 'unavailable'}
      >
        <header>
          <Users size={17} /> Members
          {drawer && (
            <button aria-label="Close members" onClick={close}>
              <X size={18} />
            </button>
          )}
        </header>
        {privateConversation ? (
          <div className="member-views" role="group" aria-label="Member view">
            <button aria-pressed={view === 'participants'} onClick={() => setView('participants')}>
              Participants
            </button>
            <button aria-pressed={view === 'community'} onClick={() => setView('community')}>
              Community
            </button>
          </div>
        ) : (
          <h2 className="section-label">Community</h2>
        )}
        {!rosterAvailable ? (
          <p className="member-note" role="status">
            Member list unavailable. <button onClick={retry}>Retry members</button>
          </p>
        ) : !ready ? (
          <p className="member-note" role="status">
            Presence unavailable{!connected ? ' · Reconnecting…' : ''}. Counts unavailable.{' '}
            <button onClick={retry} disabled={!connected}>
              Retry presence
            </button>
          </p>
        ) : null}
        <div className="member-roster">
          {ready ? (
            <>
              <h2 className="section-label">Online ({groups.online.length})</h2>
              {groups.online.map((person) => row(person, 'online'))}
              {!groups.online.length && <p className="member-note">No one online in this view.</p>}
              <button
                className="offline-toggle section-label"
                aria-expanded={offlineExpanded}
                onClick={() => setOfflineExpanded(!offlineExpanded)}
              >
                Offline ({groups.offline.length}) {offlineExpanded ? '▾' : '▸'}
              </button>
              {offlineExpanded && groups.offline.map((person) => row(person, 'offline'))}
              {groups.unavailable.length > 0 && <h2 className="section-label">Unavailable</h2>}
              {groups.unavailable.map((person) => row(person, 'unavailable'))}
            </>
          ) : (
            roster.map((person) => row(person, 'unavailable'))
          )}
          {rosterAvailable && !roster.length && (
            <p className="member-note">No members in this view.</p>
          )}
        </div>
        <p className="member-note">
          Online means connected to Rajcord, including background apps. It does not mean reading or
          available to answer.
        </p>
        <div className="member-note">
          <button
            onClick={() => {
              close();
              settings();
            }}
          >
            Manage accounts & approvals →
          </button>
        </div>
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
    </>
  );
}
