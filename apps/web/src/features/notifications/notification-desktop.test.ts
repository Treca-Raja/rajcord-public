import { expect, it, vi } from 'vitest';
import { desktopNotificationVersion, deliverDesktopNotification } from './notification-desktop';
const id = '4e4b4a40-6937-4e01-bff2-6c30254180bd';
const target = { conversationId: id, messageId: id, thread: true };
function legacy() {
  return {
    platform: 'linux',
    version: 'old',
    enableNotifications: vi.fn(async () => true),
    notify: vi.fn(async () => true),
    onNotificationOpen: () => () => undefined,
  };
}
it('negotiates old preload and sends exactly its legacy payload, never silent false success', async () => {
  const bridge = legacy();
  const version = await desktopNotificationVersion(bridge);
  expect(version).toBe(1);
  expect(await deliverDesktopNotification(bridge, version, target, true)).toEqual({
    status: 'shown',
  });
  expect(bridge.notify).toHaveBeenCalledWith({ conversationId: id, mention: true });
  bridge.notify.mockResolvedValue(false);
  expect(await deliverDesktopNotification(bridge, version, target, false)).toEqual({
    status: 'unavailable',
  });
});
it('negotiates targets and explicit native coalescing, with a legacy-main fallback', async () => {
  const bridge = {
    ...legacy(),
    notificationCapabilities: vi.fn(async () => ({ version: 2 as const })),
    notifyTarget: vi.fn(async () => ({ status: 'coalesced' as const, count: 2 })),
  };
  expect(await desktopNotificationVersion(bridge)).toBe(2);
  expect(await deliverDesktopNotification(bridge, 2, target, false)).toEqual({
    status: 'coalesced',
    count: 2,
  });
  expect(bridge.notifyTarget).toHaveBeenCalledWith({ version: 2, target, mention: false });
  expect(bridge.notify).not.toHaveBeenCalled();
  bridge.notificationCapabilities.mockRejectedValue(new Error('No handler'));
  expect(await desktopNotificationVersion(bridge)).toBe(1);
  bridge.notifyTarget.mockRejectedValue(new Error('IPC failed'));
  await expect(deliverDesktopNotification(bridge, 2, target, false)).rejects.toThrow('IPC failed');
});
