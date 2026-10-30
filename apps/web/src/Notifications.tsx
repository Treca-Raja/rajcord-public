import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';
import type { MessageNotice, NotificationTarget } from '@tricord/shared';
import { useAuth } from './Auth';
import {
  shouldNotify,
  notificationBody,
  notificationTarget,
  deviceNotifications,
  readDeviceNotifications,
  inAppNotice,
  notificationOutputs,
  needsNotificationPrompt,
  type DeviceNotificationPreferences,
} from './notification-policy';
import { NotificationCoordinator } from './notification-coordination';
import { holdNotificationPeer } from './notification-peer-lease';
import { NotificationAudio } from './notification-audio';
import { desktopNotificationVersion, deliverDesktopNotification } from './notification-desktop';
import { NotificationPreferences } from './NotificationPreferences';
import './notifications.css';

type Toast = { id: string; target: NotificationTarget; text: string };
const focused = () => document.visibilityState === 'visible' && document.hasFocus();
export function Notifications({
  selected,
  onOpen,
}: {
  selected: string | null;
  onOpen: (target: NotificationTarget) => void;
}) {
  const { state, socket, openSettings, notificationSettingsHost } = useAuth();
  const key = 'tricord-notification-device-v2:' + state.user.id;
  const [device, setDevice] = useState<DeviceNotificationPreferences>(() => {
    try {
      return readDeviceNotifications(localStorage, state.user.id);
    } catch {
      return deviceNotifications(null);
    }
  });
  const loadedAccount = useRef(state.user.id);
  const [error, setError] = useState('');
  const [popupError, setPopupError] = useState('');
  const [soundError, setSoundError] = useState('');
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [prompt, setPrompt] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const audio = useRef(new NotificationAudio());
  const coordinator = useRef<NotificationCoordinator | null>(null);
  const popupReady = useRef(true);
  const current = useRef({ selected, onOpen, device });
  current.current = {
    selected,
    onOpen,
    device: loadedAccount.current === state.user.id ? device : deviceNotifications(null),
  };
  useEffect(() => {
    try {
      setPrompt(needsNotificationPrompt(localStorage, state.user.id));
    } catch {
      setError('Notification setup preferences could not be read.');
    }
  }, [state.user.id]);
  function dismissPrompt() {
    setPrompt(false);
    try {
      localStorage.setItem('tricord-notification-prompt:' + state.user.id, 'seen');
    } catch {
      setError('Your notification setup choice could not be saved.');
    }
  }
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        try {
          loadedAccount.current = state.user.id;
          setDevice(readDeviceNotifications(localStorage, state.user.id));
        } catch {
          setError('Device alert settings could not be read. Alerts remain off until saved.');
          setDevice(deviceNotifications(null));
        }
      }
    };
    try {
      loadedAccount.current = state.user.id;
      setDevice(readDeviceNotifications(localStorage, state.user.id));
    } catch {
      setError('Device alert settings could not be read. Alerts remain off until saved.');
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key, state.user.id]);
  useEffect(() => {
    let active = true;
    popupReady.current = true;
    const notices = new Set<Notification>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const bridge = window.tricordDesktop;
    const version = bridge ? desktopNotificationVersion(bridge) : Promise.resolve(1 as const);
    const open = (value: unknown) => {
      const target = notificationTarget(value);
      if (target && active) current.current.onOpen(target);
    };
    const removeLegacy = bridge?.onNotificationOpen(open);
    const removeModern = bridge?.onNotificationTarget?.(open);
    let coordination: NotificationCoordinator | null = null;
    let peer: ReturnType<typeof holdNotificationPeer> | undefined;
    try {
      if (!navigator.locks || typeof navigator.locks.query !== 'function')
        throw new Error('This browser cannot safely coordinate tabs. Device alerts are paused.');
      const tabId = crypto.randomUUID();
      peer = holdNotificationPeer(navigator.locks, state.user.id, tabId);
      coordination = new NotificationCoordinator(
        state.user.id,
        tabId,
        localStorage,
        (work) =>
          navigator.locks.request(
            'tricord-notifications:' + state.user.id,
            { signal: AbortSignal.timeout(1500) },
            work,
          ),
        Date.now,
        peer.livePeers,
      );
      coordinator.current = coordination;
    } catch (cause) {
      setError((cause as Error).message);
    }
    const updatePresence = () => {
      void coordination
        ?.update(current.current.selected, focused(), socket?.connected === true)
        .catch(
          () => active && setError('Tab coordination failed. Alerts are paused; reload to retry.'),
        );
    };
    updatePresence();
    window.addEventListener('focus', updatePresence);
    window.addEventListener('blur', updatePresence);
    document.addEventListener('visibilitychange', updatePresence);
    socket?.on('connect', updatePresence);
    socket?.on('disconnect', updatePresence);
    const heartbeat = setInterval(updatePresence, 2000);
    const toast = (notice: MessageNotice, target: NotificationTarget) => {
      setToasts((items) => {
        const next = [
          ...items,
          {
            id: notice.messageId,
            target,
            text: inAppNotice(notice, current.current.device.preview),
          },
        ];
        for (const removed of next.slice(0, -3)) {
          clearTimeout(timers.get(removed.id));
          timers.delete(removed.id);
        }
        return next.slice(-3);
      });
      timers.set(
        notice.messageId,
        setTimeout(() => {
          timers.delete(notice.messageId);
          if (active) setToasts((items) => items.filter((item) => item.id !== notice.messageId));
        }, 8000),
      );
    };
    async function created(notice: MessageNotice) {
      const target = notificationTarget({
        conversationId: notice.conversationId,
        messageId: notice.messageId,
        ...(notice.reply ? { thread: true } : {}),
      });
      if (
        !active ||
        !socket?.connected ||
        !target ||
        !coordination ||
        !current.current.device.enabled ||
        !shouldNotify(notice, state.user.id, current.current.selected, focused())
      )
        return;
      try {
        await coordination.update(current.current.selected, focused());
        const result = await coordination.claim(notice.messageId, notice.conversationId);
        if (result !== 'deliver' || !active || !socket.connected) return;
      } catch {
        if (active) setError('Tab coordination failed. Alerts are paused; reload to retry.');
        return;
      }
      let settings: DeviceNotificationPreferences;
      try {
        settings = readDeviceNotifications(localStorage, state.user.id);
        current.current.device = settings;
      } catch {
        setError('Device alert settings could not be read. Alerts are paused until saved.');
        return;
      }
      if (
        !settings.enabled ||
        !shouldNotify(notice, state.user.id, current.current.selected, focused())
      )
        return;
      const outputs = notificationOutputs(
        settings,
        focused(),
        popupReady.current &&
          (!!bridge || ('Notification' in window && Notification.permission === 'granted')),
      );
      if (outputs.sound) {
        try {
          audio.current.play(settings.volume);
        } catch (cause) {
          setSoundError((cause as Error).message);
        }
      }
      if (outputs.popup === 'none') return;
      if (outputs.popup === 'toast') {
        toast(notice, target);
      } else if (bridge) {
        try {
          const protocol = await version;
          if (!active || !socket.connected) return;
          const latest = readDeviceNotifications(localStorage, state.user.id);
          current.current.device = latest;
          if (!shouldNotify(notice, state.user.id, current.current.selected, focused())) return;
          const output = notificationOutputs(latest, focused(), popupReady.current);
          if (output.popup === 'none') return;
          if (output.popup === 'toast') {
            toast(notice, target);
            return;
          }
          const result = await deliverDesktopNotification(bridge, protocol, target, notice.mention);
          if (!active) return;
          if (result.status === 'coalesced')
            setDeliveryStatus(
              `Desktop alert combined ${result.count} messages. Open Rajcord to read them.`,
            );
          else if (result.status !== 'shown') {
            popupReady.current = false;
            setPopupError(
              'Desktop popup failed. Using in-app alerts for future messages; retry OS popups to recover.',
            );
          }
        } catch {
          if (active) {
            popupReady.current = false;
            setPopupError(
              'Desktop popup failed. Retry OS popups to recover; sound and in-app alerts remain independent.',
            );
          }
        }
      } else if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const item = new Notification('Rajcord', {
            body: notificationBody(),
            silent: true,
          });
          while (notices.size >= 8) {
            const oldest = notices.values().next().value!;
            notices.delete(oldest);
            oldest.close();
          }
          notices.add(item);
          item.onclose = () => notices.delete(item);
          item.onerror = () => {
            if (active) {
              popupReady.current = false;
              setPopupError(
                'OS popup failed. Check browser/OS settings, then retry. Future alerts stay in-app.',
              );
            }
          };
          item.onclick = () => {
            window.focus();
            open(target);
            item.close();
          };
        } catch {
          popupReady.current = false;
          setPopupError('OS popups are unavailable. Using in-app alerts; sound is independent.');
          toast(notice, target);
        }
      } else {
        toast(notice, target);
      }
    }
    const listener = (notice: MessageNotice) => void created(notice);
    socket?.on('message:created', listener);
    return () => {
      active = false;
      coordinator.current = null;
      socket?.off('message:created', listener);
      removeLegacy?.();
      removeModern?.();
      clearInterval(heartbeat);
      window.removeEventListener('focus', updatePresence);
      window.removeEventListener('blur', updatePresence);
      document.removeEventListener('visibilitychange', updatePresence);
      socket?.off('connect', updatePresence);
      socket?.off('disconnect', updatePresence);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const item of notices) item.close();
      void peer?.close().catch(() => undefined);
      void coordination?.close().catch(() => undefined);
      audio.current.close();
      setToasts([]);
    };
  }, [socket, state.user.id]);
  useEffect(() => {
    void coordinator.current
      ?.update(selected, focused(), socket?.connected === true)
      .catch(() => setError('Tab coordination failed. Alerts are paused; reload to retry.'));
  }, [selected, socket]);
  function save(patch: Partial<DeviceNotificationPreferences>) {
    const next = { ...current.current.device, ...patch };
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setDevice(next);
      current.current.device = next;
      setError('');
    } catch {
      setError('Device alert settings could not be saved. No settings were changed.');
    }
  }
  async function allowPopups() {
    setPopupError('');
    try {
      if (window.tricordDesktop) {
        if (!(await window.tricordDesktop.enableNotifications()))
          throw new Error('Desktop popups are unavailable. Check OS notification settings.');
      } else {
        if (!('Notification' in window))
          throw new Error('OS popups are unavailable in this browser.');
        if ((await Notification.requestPermission()) !== 'granted')
          throw new Error(
            'OS popups are blocked. Allow them in browser/OS settings, then retry. In-app alerts and sound remain independent.',
          );
      }
      setDeliveryStatus('OS popups enabled. In-app alerts are used while Rajcord is focused.');
      popupReady.current = true;
    } catch (cause) {
      popupReady.current = false;
      setPopupError((cause as Error).message);
    }
  }
  async function enableSound(test = false) {
    setSoundError('');
    try {
      await audio.current.unlock();
      save({ sound: true });
      if (test) audio.current.play(current.current.device.volume);
    } catch (cause) {
      setSoundError((cause as Error).message);
    }
  }
  const controls = (
    <div className="notification-settings">
      <div className="notification-settings-heading">
        <div>
          <h3>Notifications</h3>
          <p>Choose how Rajcord gets your attention. Unread badges always stay on.</p>
        </div>
        <button
          className={device.enabled ? 'secondary' : 'primary'}
          aria-pressed={device.enabled}
          onClick={() => {
            dismissPrompt();
            save({ enabled: !device.enabled });
          }}
        >
          {device.enabled ? 'Disable notifications' : 'Enable notifications'}
        </button>
      </div>
      <fieldset>
        <legend>On this device</legend>
        <label>
          <input
            type="checkbox"
            aria-label="Notification popups"
            checked={device.popup}
            onChange={(event) => {
              save({ popup: event.target.checked });
              if (event.target.checked) void allowPopups();
            }}
          />
          Popups <small>In-app while focused; browser or desktop alerts while away.</small>
        </label>
        <button className="text-button" onClick={() => void allowPopups()}>
          Allow / retry OS popups
        </button>
        <label>
          <input
            type="checkbox"
            aria-label="Notification sound"
            checked={device.sound}
            onChange={(event) =>
              event.target.checked ? void enableSound() : save({ sound: false })
            }
          />
          Sound <small>A short tone for eligible new activity.</small>
        </label>
        <button className="secondary" onClick={() => void enableSound(true)}>
          Enable / test sound
        </button>
        <label>
          Volume{' '}
          <input
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.05"
            value={device.volume}
            onChange={(event) => save({ volume: Number(event.target.value) })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={device.preview}
            onChange={(event) => save({ preview: event.target.checked })}
          />
          Show activity reason in in-app previews
        </label>
        <small>
          Popup and sound are independent and off by default. OS alerts never include names, message
          text or media. Sound may need enabling again after reopening Rajcord.
        </small>
      </fieldset>
      <NotificationPreferences key={state.user.id} selected={selected} />
      {error && <small role="alert">{error}</small>}
      {popupError && <small role="status">{popupError}</small>}
      {soundError && <small role="status">{soundError}</small>}
      {deliveryStatus && <small role="status">{deliveryStatus}</small>}
    </div>
  );
  return (
    <>
      {notificationSettingsHost && createPortal(controls, notificationSettingsHost)}
      {prompt && !notificationSettingsHost && (
        <aside className="notification-invitation" aria-label="Set up notifications">
          <Bell size={21} aria-hidden="true" />
          <div>
            <strong>Keep up with your people</strong>
            <p>
              Want alerts for mentions, replies and messages? You choose popups, sound, or neither.
            </p>
            <button
              className="primary"
              onClick={() => {
                dismissPrompt();
                openSettings('notifications');
              }}
            >
              Set up notifications
            </button>
            <button className="text-button" onClick={dismissPrompt}>
              Not now
            </button>
          </div>
          <button
            className="notification-invitation-close"
            title="Not now"
            aria-label="Dismiss notification setup"
            onClick={dismissPrompt}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </aside>
      )}
      {!notificationSettingsHost && (error || popupError || soundError) && (
        <div className="notification-feedback" role="status">
          {error || popupError || soundError}
          <button onClick={() => openSettings('notifications')}>Notification settings</button>
        </div>
      )}
      <div className="notification-toasts" aria-live="polite" aria-label="New activity">
        {toasts.map((toast) => (
          <div className="notification-toast" key={toast.id}>
            <button
              onClick={() => {
                onOpen(toast.target);
                setToasts((items) => items.filter((item) => item.id !== toast.id));
              }}
            >
              {toast.text} · Open
            </button>
            <button
              aria-label="Dismiss notification"
              onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
