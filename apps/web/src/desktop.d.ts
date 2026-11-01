type DesktopNotificationTarget = {
  conversationId: string;
  messageId?: string;
  thread?: boolean;
};
type DesktopNotificationResult =
  | { status: 'shown' }
  | { status: 'coalesced'; count: number }
  | { status: 'unavailable' | 'invalid' };
interface Window {
  readonly tricordDesktop?: {
    readonly platform: string;
    readonly version: string;
    readonly enableNotifications: () => Promise<boolean>;
    readonly notify: (notice: { conversationId: string; mention: boolean }) => Promise<boolean>;
    readonly onNotificationOpen: (callback: (conversationId: string) => void) => () => void;
    readonly notificationCapabilities?: () => Promise<{ version: 2 }>;
    readonly notifyTarget?: (notice: {
      version: 2;
      target: DesktopNotificationTarget;
      mention: boolean;
    }) => Promise<DesktopNotificationResult>;
    readonly onNotificationTarget?: (
      callback: (target: DesktopNotificationTarget) => void,
    ) => () => void;
  };
}
