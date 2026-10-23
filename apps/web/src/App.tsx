import { useEffect, useState } from 'react';
import { AuthRoot, useAuth } from './Auth';
import './auth.css';
import {
  Hash,
  Headphones,
  Mic,
  Settings,
  Volume2,
  Users,
  ChevronDown,
  Plus,
  Send,
  Compass,
  Bell,
  Menu,
  X,
  ShieldCheck,
  Radio,
} from 'lucide-react';
import { Avatar, Badge } from '@tricord/ui';
import type { AuthUser } from '@tricord/shared';

const channels = ['general', 'gaming', 'off-topic', 'links-and-finds'];
const people = [
  { name: 'Alex', initials: 'A', tone: 'purple' as const },
  { name: 'Sam', initials: 'S', tone: 'green' as const },
  { name: 'Jamie', initials: 'J', tone: 'orange' as const },
];
const messages = [
  { person: 0, time: '18:42', text: 'A little space of our own. Welcome to Tricord 👋' },
  {
    person: 1,
    time: '18:43',
    text: 'The essentials: good conversations, game nights, and everyone in the same place.',
  },
  { person: 2, time: '18:45', text: 'Already feels like home. Who’s up for a game later?' },
  { person: 0, time: '18:46', text: 'Count me in. I’ll bring the questionable strategies.' },
];
export function App() {
  return (
    <AuthRoot>
      <Community />
    </AuthRoot>
  );
}
function Community() {
  const { state, connected, openSettings, request } = useAuth();
  const [members, setMembers] = useState<AuthUser[]>([]);
  const [channel, setChannel] = useState('general');
  const health = 'Authenticated API';
  const [notice, setNotice] = useState('');
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    void request<{ users: AuthUser[] }>('/members')
      .then((data) => setMembers(data.users))
      .catch(() => setNotice('Unable to load members.'));
  }, [state.user.id, state.user.status]);
  const placeholder = (feature: string) =>
    setNotice(`${feature} is planned for a later milestone. This is a demo interface.`);
  return (
    <div className={'shell' + (mobile ? ' mobile-open' : '')}>
      <nav className="rail" aria-label="Platform">
        <div className="logo">
          t<span>•</span>
        </div>
        <div className="rail-rule" />
        <button
          className="rail-active"
          title="Home"
          aria-label="Home"
          onClick={() => {
            setChannel('general');
            setNotice('');
          }}
        >
          <Compass />
        </button>
        <button title="People" aria-label="People" onClick={openSettings}>
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
          TEXT CHANNELS <span>4</span>
        </div>
        <div className="channels">
          {channels.map((name) => (
            <button
              key={name}
              className={channel === name ? 'selected' : ''}
              onClick={() => {
                setChannel(name);
                setMobile(false);
              }}
            >
              <Hash size={18} />
              {name}
              {name === 'general' && <span className="channel-dot" />}
            </button>
          ))}
        </div>
        <div className="section-label voice-label">VOICE CHANNELS</div>
        <button className="voice-channel" onClick={() => placeholder('Voice chat')}>
          <Volume2 size={18} /> The lounge <Badge>SOON</Badge>
        </button>
        <div className="voice-caption">A place to drop in and hang out.</div>
        <div className="grow" />
        <div className="sidebar-note">
          <Radio size={19} />
          <strong>Built for us.</strong>
          <p>
            A quieter place to keep in touch.
            <br />
            One community. Your own space.
          </p>
        </div>
        <div className="profile">
          <Avatar>{state.user.displayName.slice(0, 1)}</Avatar>
          <div>
            <strong>{state.user.displayName}</strong>
            <small>{state.user.isOwner ? 'Platform owner' : 'Member · administrator'}</small>
          </div>
          <button
            aria-label="Microphone settings"
            onClick={() => placeholder('Microphone controls')}
          >
            <Mic size={16} />
          </button>
          <button aria-label="Audio settings" onClick={() => placeholder('Audio controls')}>
            <Headphones size={16} />
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
          <Hash size={23} />
          <strong>{channel}</strong>
          <span className="header-divider" />
          <span className="channel-topic">
            The everyday, the unexpected, and everything between.
          </span>
          <div className="grow" />
          <button aria-label="Notifications" onClick={() => placeholder('Notifications')}>
            <Bell size={18} />
          </button>
          <Badge>DEMO</Badge>
        </header>
        <div className="foundation-banner">
          <span className="foundation-icon">
            <ShieldCheck size={16} />
          </span>
          <div>
            <strong>A foundation for something ours.</strong>
            <span> Milestone 2A · Accounts are live. Conversations below are samples.</span>
          </div>
        </div>
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="conversation">
          <div className="welcome">
            <div className="welcome-hash">
              <Hash size={36} />
            </div>
            <div className="eyebrow">MAKE YOURSELF AT HOME</div>
            <h1>
              This is the start of <span>#{channel}.</span>
            </h1>
            <p>
              {channel === 'general'
                ? 'A shared space for the small talk, the big plans, and the friends in between.'
                : 'This channel is ready for your future conversations.'}
            </p>
            <div className="welcome-tags">
              <span>
                <Users size={12} /> One private community
              </span>
              <span>✦ Made for friends</span>
            </div>
          </div>
          <div className="date-divider">
            <span>Sample conversation · preview only</span>
          </div>
          {channel === 'general' ? (
            messages.map((message, index) => {
              const person = people[message.person]!;
              return (
                <article className="message" key={index}>
                  <Avatar tone={person.tone}>{person.initials}</Avatar>
                  <div>
                    <div className="message-meta">
                      <strong>{person.name}</strong>
                      <time>{message.time}</time>
                      {index === 0 && <span>SAMPLE</span>}
                    </div>
                    <p>{message.text}</p>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="empty-channel">
              <Hash size={25} />
              <strong>A fresh start.</strong>
              <p>No sample messages in this channel. Real messaging comes later.</p>
            </div>
          )}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <Plus size={20} />
            <input
              aria-label="Message composer unavailable"
              placeholder={`Messaging in #${channel} is coming next`}
              disabled
            />
            <button aria-label="Sending messages is not implemented" disabled>
              <Send size={18} />
            </button>
          </div>
          <div className="composer-footer">
            <span>Demo content stays in this preview. Nothing is sent or saved.</span>
            <span
              data-connection={connected ? 'connected' : 'disconnected'}
              className={connected ? 'connection good' : 'connection'}
            >
              <i />
              {connected ? 'Live connection verified' : 'API disconnected'}
            </span>
          </div>
        </div>
      </section>
      <aside className="members">
        <header>
          <Users size={17} /> THE PEOPLE <span>{members.length} approved</span>
        </header>
        <div className="section-label">COMMUNITY MEMBERS</div>
        {members.map((member) => (
          <div className="member" key={member.id}>
            <Avatar>{member.displayName.slice(0, 1)}</Avatar>
            <div>
              <strong>{member.displayName}</strong>
              <small>{member.isOwner ? 'Owner' : 'Member · administrator'}</small>
            </div>
          </div>
        ))}
        <div className="member-note">
          <button onClick={openSettings}>Manage accounts & approvals →</button>
        </div>
        <div className="grow" />
        <div className="system-card">
          <div>
            <span className={connected ? 'status-dot online' : 'status-dot'} />
            <strong>Foundation status</strong>
          </div>
          <p>{health}</p>
          <p>{connected ? 'Socket.IO round trip verified' : 'Waiting for Socket.IO'}</p>
          <span>LOCAL DEVELOPMENT</span>
        </div>
        <div className="version">
          TRICORD <span>v0.1.0</span>
        </div>
      </aside>
    </div>
  );
}
