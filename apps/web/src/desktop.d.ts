interface Window {
  readonly tricordDesktop?: {
    readonly platform: string;
    readonly version: string;
    readonly enableNotifications: () => Promise<boolean>;
    readonly notify: (notice: { conversationId: string; mention: boolean }) => Promise<boolean>;
    readonly onNotificationOpen: (callback: (conversationId: string) => void) => () => void;
  };
}
