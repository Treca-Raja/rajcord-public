import type { NotificationTarget } from '@tricord/shared';

type Bridge = NonNullable<Window['tricordDesktop']>;
export async function desktopNotificationVersion(bridge: Bridge): Promise<1 | 2> {
  if (!bridge.notificationCapabilities || !bridge.notifyTarget) return 1;
  try {
    return (await bridge.notificationCapabilities()).version === 2 ? 2 : 1;
  } catch {
    // An older main process may not have the capability handler yet.
    return 1;
  }
}
export async function deliverDesktopNotification(
  bridge: Bridge,
  version: 1 | 2,
  target: NotificationTarget,
  mention: boolean,
): Promise<DesktopNotificationResult> {
  if (version === 2 && bridge.notifyTarget)
    return bridge.notifyTarget({ version: 2, target, mention });
  return (await bridge.notify({ conversationId: target.conversationId, mention }))
    ? { status: 'shown' }
    : { status: 'unavailable' };
}
