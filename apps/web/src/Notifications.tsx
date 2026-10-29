import { useEffect, useRef, useState } from 'react';
import type { MessageNotice } from '@tricord/shared';
import { useAuth } from './Auth';
import { shouldNotify, notificationBody } from './notification-policy';
export function Notifications({
  selected,
  onOpen,
}: {
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const { state, socket } = useAuth();
  const preference = 'tricord-notifications:' + state.user.id;
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(preference) === 'on';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState('');
  const current = useRef({ selected, onOpen, enabled });
  current.current = { selected, onOpen, enabled };
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const notifications = new Set<Notification>();
    const remove = window.tricordDesktop?.onNotificationOpen((id) => current.current.onOpen(id));
    const created = (notice: MessageNotice) => {
      if (seen.current.has(notice.messageId)) return;
      seen.current.add(notice.messageId);
      if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value!);
      const focused = document.visibilityState === 'visible' && document.hasFocus();
      if (
        !current.current.enabled ||
        !shouldNotify(notice, state.user.id, current.current.selected, focused)
      )
        return;
      if (window.tricordDesktop) {
        void window.tricordDesktop
          .notify({ conversationId: notice.conversationId, mention: notice.mention })
          .then((ok) => {
            if (!ok)
              setError('Desktop alerts are unavailable. Check Windows notification settings.');
          })
          .catch(() => setError('Desktop alerts are unavailable.'));
      } else if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const notification = new Notification('Rajcord', {
            body: notificationBody(notice.mention),
            tag: 'tricord:' + notice.conversationId,
          });
          notifications.add(notification);
          notification.onclose = () => notifications.delete(notification);
          notification.onclick = () => {
            window.focus();
            current.current.onOpen(notice.conversationId);
            notification.close();
          };
        } catch {
          setError('This browser cannot show desktop alerts.');
        }
      }
    };
    socket?.on('message:created', created);
    return () => {
      socket?.off('message:created', created);
      remove?.();
      for (const item of notifications) item.close();
    };
  }, [socket, state.user.id]);
  async function toggle() {
    setError('');
    let next = !enabled;
    if (next && window.tricordDesktop) {
      try {
        next = await window.tricordDesktop.enableNotifications();
      } catch {
        next = false;
      }
      if (!next)
        setError('Desktop notification setup failed. Check Windows notification settings.');
    }
    if (next && !window.tricordDesktop) {
      if (!('Notification' in window)) {
        setError('Notifications are unavailable in this browser.');
        return;
      }
      try {
        next = (await Notification.requestPermission()) === 'granted';
      } catch {
        next = false;
      }
      if (!next) setError('Allow notifications in your browser settings to enable alerts.');
    }
    setEnabled(next);
    try {
      localStorage.setItem(preference, next ? 'on' : 'off');
    } catch {
      setError('Your notification preference could not be saved.');
    }
  }
  return (
    <div className="notification-settings">
      <button onClick={() => void toggle()} aria-pressed={enabled}>
        {enabled ? 'Disable notifications' : 'Enable notifications'}
      </button>
      <small>Private messages & @mentions · while Rajcord is open</small>
      {error && <small role="status">{error}</small>}
    </div>
  );
}
