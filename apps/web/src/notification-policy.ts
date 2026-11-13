import type { MessageNotice, NotificationTarget } from '@tricord/shared';
export function shouldNotify(
  notice: MessageNotice,
  userId: string,
  selected: string | null,
  focused: boolean,
) {
  const preferences = notice.preferences ?? {
    mode: notice.kind === 'channel' ? 'mentions' : 'all',
    senderMuted: false,
    priority: false,
  };
  return (
    notice.authorId !== userId &&
    !(focused && notice.conversationId === selected) &&
    preferences.mode !== 'muted' &&
    !preferences.senderMuted &&
    (preferences.mode === 'all' || preferences.priority || notice.mention || notice.reply === true)
  );
}
export function notificationBody(_mention?: boolean) {
  return 'New activity. Open Rajcord to read it.';
}
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function notificationTarget(value: unknown): NotificationTarget | null {
  if (typeof value === 'string') value = { conversationId: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !['conversationId', 'messageId', 'thread'].includes(key)) ||
    typeof data.conversationId !== 'string' ||
    !identifier.test(data.conversationId) ||
    (data.messageId !== undefined &&
      (typeof data.messageId !== 'string' || !identifier.test(data.messageId))) ||
    (data.thread !== undefined && typeof data.thread !== 'boolean') ||
    (data.thread === true && !data.messageId)
  )
    return null;
  return data as unknown as NotificationTarget;
}
export type DeviceNotificationPreferences = {
  enabled: boolean;
  popup: boolean;
  sound: boolean;
  volume: number;
  preview: boolean;
};
export const defaultDeviceNotifications: DeviceNotificationPreferences = {
  enabled: false,
  popup: false,
  sound: false,
  volume: 0.4,
  preview: false,
};
export function deviceNotifications(raw: string | null): DeviceNotificationPreferences {
  if (!raw) return { ...defaultDeviceNotifications };
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ...defaultDeviceNotifications };
    const value = data as Record<string, unknown>;
    return {
      enabled: value.enabled === true,
      popup: value.popup === true,
      sound: value.sound === true,
      volume:
        typeof value.volume === 'number' && Number.isFinite(value.volume)
          ? Math.min(1, Math.max(0, value.volume))
          : defaultDeviceNotifications.volume,
      preview: value.preview === true,
    };
  } catch {
    return { ...defaultDeviceNotifications };
  }
}
export function readDeviceNotifications(
  storage: Pick<Storage, 'getItem'>,
  accountId: string,
): DeviceNotificationPreferences {
  const raw = storage.getItem('tricord-notification-device-v2:' + accountId);
  if (raw !== null) return deviceNotifications(raw);
  return {
    ...defaultDeviceNotifications,
    ...(storage.getItem('tricord-notifications:' + accountId) === 'on'
      ? { enabled: true, popup: true }
      : {}),
  };
}
export function needsNotificationPrompt(storage: Pick<Storage, 'getItem'>, accountId: string) {
  return (
    storage.getItem('tricord-notification-prompt:' + accountId) === null &&
    storage.getItem('tricord-notification-device-v2:' + accountId) === null &&
    storage.getItem('tricord-notifications:' + accountId) === null
  );
}
export function inAppNotice(notice: MessageNotice, preview: boolean) {
  if (!preview) return 'New activity in Rajcord';
  return notice.mention
    ? 'You were mentioned'
    : notice.reply
      ? 'A reply to your message'
      : 'New message';
}
export function notificationOutputs(
  settings: DeviceNotificationPreferences,
  focused: boolean,
  osAvailable: boolean,
) {
  return {
    sound: settings.enabled && settings.sound,
    popup:
      !settings.enabled || !settings.popup
        ? ('none' as const)
        : focused || !osAvailable
          ? ('toast' as const)
          : ('os' as const),
  };
}
