export type ConversationAlertMode = 'all' | 'mentions' | 'muted';
export interface NoticePreferences {
  mode: ConversationAlertMode;
  senderMuted: boolean;
  priority: boolean;
}
export interface NotificationTarget {
  conversationId: string;
  messageId?: string;
  thread?: boolean;
}
export interface ConversationAlertPreference {
  conversationId: string;
  mode: ConversationAlertMode;
  defaultMode: ConversationAlertMode;
  overridden: boolean;
}
export interface SenderAlertPreference {
  senderId: string;
  username: string;
  displayName: string;
  muted: boolean;
  priority: boolean;
}
export interface SenderAlertPreferencePage {
  senders: SenderAlertPreference[];
  nextCursor: string | null;
}
