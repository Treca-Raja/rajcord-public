import { useEffect, useRef, useState } from 'react';
import type {
  ConversationAlertPreference,
  ConversationAlertMode,
  SenderAlertPreference,
  SenderAlertPreferencePage,
} from '@tricord/shared';
import { useAuth } from './Auth';

export function NotificationPreferences({ selected }: { selected: string | null }) {
  const { request, socket } = useAuth();
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const [conversation, setConversation] = useState<ConversationAlertPreference | null>(null);
  const [senders, setSenders] = useState<SenderAlertPreference[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 250);
    };
    socket?.on('notification:preferences-changed', changed);
    socket?.on('connect', changed);
    return () => {
      clearTimeout(timer);
      socket?.off('notification:preferences-changed', changed);
      socket?.off('connect', changed);
    };
  }, [socket]);
  useEffect(() => {
    const started = ++generation.current;
    setConversation(null);
    setSenders([]);
    setNext(null);
    setError('');
    setBusy(true);
    void Promise.all([
      selected
        ? currentRequest.current<ConversationAlertPreference>(
            '/conversations/' + selected + '/notification-preference',
          )
        : Promise.resolve(null),
      currentRequest.current<SenderAlertPreferencePage>('/sender-alert-preferences?limit=50'),
    ])
      .then(([preference, page]) => {
        if (started !== generation.current) return;
        setConversation(preference);
        setSenders(page.senders);
        setNext(page.nextCursor);
      })
      .catch((cause: Error) => {
        if (started === generation.current) setError(cause.message);
      })
      .finally(() => {
        if (started === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [selected, revision]);
  async function changeMode(mode: ConversationAlertMode | null) {
    if (!selected || busy) return;
    const started = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await request<ConversationAlertPreference>(
        '/conversations/' + selected + '/notification-preference',
        'PATCH',
        { mode },
      );
      if (started === generation.current) setConversation(result);
    } catch (cause) {
      if (started === generation.current) setError((cause as Error).message);
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }
  async function changeSender(sender: SenderAlertPreference, field: 'muted' | 'priority') {
    if (busy) return;
    const started = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await request<Pick<SenderAlertPreference, 'senderId' | 'muted' | 'priority'>>(
        '/sender-alert-preferences/' + sender.senderId,
        'PATCH',
        { [field]: !sender[field] },
      );
      if (started === generation.current)
        setSenders((items) =>
          items.map((item) => (item.senderId === result.senderId ? { ...item, ...result } : item)),
        );
    } catch (cause) {
      if (started === generation.current) setError((cause as Error).message);
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }
  async function more() {
    if (!next || busy) return;
    const started = generation.current;
    setBusy(true);
    setError('');
    try {
      const page = await request<SenderAlertPreferencePage>(
        '/sender-alert-preferences?limit=50&after=' + encodeURIComponent(next),
      );
      if (started === generation.current) {
        setSenders((items) => [...items, ...page.senders]);
        setNext(page.nextCursor);
      }
    } catch (cause) {
      if (started === generation.current) setError((cause as Error).message);
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }
  return (
    <fieldset className="notification-account" disabled={busy}>
      <legend>Account alert rules · synced to your devices</legend>
      {conversation && (
        <label>
          Selected conversation
          <select
            value={conversation.overridden ? conversation.mode : 'default'}
            onChange={(event) =>
              void changeMode(
                event.target.value === 'default'
                  ? null
                  : (event.target.value as ConversationAlertMode),
              )
            }
          >
            <option value="default">Default ({conversation.defaultMode})</option>
            <option value="all">All messages</option>
            <option value="mentions">Mentions and replies</option>
            <option value="muted">Muted</option>
          </select>
        </label>
      )}
      {!selected && <small>Select a conversation to change its alert rule.</small>}
      <small>
        Channels default to mentions and replies; direct and group messages default to all. Priority
        includes other messages, but never overrides any mute or device setting.
      </small>
      <div className="notification-senders">
        {senders.map((sender) => (
          <div className="notification-sender" key={sender.senderId}>
            <span>
              {sender.displayName} <small>@{sender.username}</small>
            </span>
            <label>
              <input
                type="checkbox"
                aria-label={'Mute alerts from ' + sender.displayName}
                checked={sender.muted}
                onChange={() => void changeSender(sender, 'muted')}
              />
              Mute
            </label>
            <label>
              <input
                type="checkbox"
                aria-label={'Prioritize alerts from ' + sender.displayName}
                checked={sender.priority}
                onChange={() => void changeSender(sender, 'priority')}
              />
              Priority
            </label>
          </div>
        ))}
      </div>
      {next && <button onClick={() => void more()}>Load more senders</button>}
      {busy && <small role="status">Saving or loading alert rules…</small>}
      {error && (
        <small role="alert">
          {error} <button onClick={() => setRevision((value) => value + 1)}>Retry</button>
        </small>
      )}
    </fieldset>
  );
}
