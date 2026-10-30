export type AccountStatus = 'pending' | 'approved' | 'rejected' | 'suspended' | 'removed';
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  status: AccountStatus;
  isOwner: boolean;
}
export interface AuthState {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
  remember: boolean;
}
export interface HealthResponse {
  status: 'ok';
  service: 'tricord-api';
  milestone: 2;
}
export interface ConnectionWelcome {
  message: string;
  connectedAt: string;
}
// Presence describes authorized application connections, never account approval or activity.
export interface PresenceSnapshot {
  epoch: string;
  revision: number;
  onlineIds: string[];
}
export interface PresenceDelta {
  epoch: string;
  revision: number;
  changes: { userId: string; online: boolean }[];
  rosterChanged: boolean;
}
export const PRESENCE_TIMING = {
  pingIntervalMs: 25000,
  pingTimeoutMs: 20000,
  reconnectGraceMs: 5000,
  authorizationCheckMs: 15000,
  snapshotTimeoutMs: 5000,
} as const;
export interface ServerToClientEvents {
  'presence:changed': (payload: PresenceDelta) => void;
  'presence:unavailable': () => void;
  'connection:welcome': (payload: ConnectionWelcome) => void;
  'account:changed': () => void;
  'inbox:changed': () => void;
  'unread:changed': (data: ConversationUnread) => void;
  'message:created': (data: MessageNotice) => void;
  'conversation:changed': (data: { conversationId: string }) => void;
  'conversation:closed': (data: { conversationId: string }) => void;
  'notification:preferences-changed': () => void;
  'chat:unavailable': () => void;
}
export interface ClientToServerEvents {
  'presence:snapshot': (ack: (result: ChatAck<PresenceSnapshot>) => void) => void;
  'conversation:join': (
    data: { conversationId: string },
    ack: (result: ChatAck<{ joined: true }>) => void,
  ) => void;
  'conversation:read': (
    data: { conversationId: string; seq: string },
    ack: (result: ChatAck<{ lastReadSeq: string }>) => void,
  ) => void;
  'message:send': (
    data: { conversationId: string; clientId: string; body: string; replyToId?: string | null },
    ack: (result: ChatAck<ChatMessage>) => void,
  ) => void;
  'connection:ping': (ack: (response: { ok: boolean }) => void) => void;
}

export interface Conversation {
  id: string;
  kind: 'channel' | 'dm' | 'group';
  name: string;
  archived: boolean;
  topic: string;
  category: ChannelCategory | null;
  position: number;
  metadataRevision: string;
  unreadCount: number;
  mentionCount: number;
  lastReadSeq: string;
  activity: string;
  managerId: string | null;
  members: { id: string; displayName: string; username: string; status: AccountStatus }[];
}
export interface ChannelCategory {
  id: string;
  name: string;
  position: number;
  revision: string;
}
export interface ChannelCategoryPage {
  categories: ChannelCategory[];
  nextAfter: string | null;
}
export interface ChatMessage {
  featureVersion: 1 | 2;
  id: string;
  conversationId: string;
  clientId: string;
  seq: string;
  change: string;
  contextChange: string;
  author: { id: string; username: string; displayName: string };
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  replyTo: MessageReference | null;
  threadRoot: MessageReference | null;
  replyCount: number;
  pinned: boolean;
  reactions: MessageReaction[];
  mentions: { id: string; username: string }[];
}
export type MessageReference =
  | { available: false }
  | {
      available: true;
      id: string;
      seq: string;
      change: string;
      author: ChatMessage['author'];
      body: string | null;
      deleted: boolean;
    };
export interface MessageReaction {
  emoji: string;
  count: number;
  mine: boolean;
}
export interface PinnedPage {
  messages: ChatMessage[];
  nextBefore: string | null;
  total: number;
}
export interface ThreadPage extends MessagePage {
  root: ChatMessage | null;
}
export interface MessageContext extends MessagePage {
  hasNewer: boolean;
  anchorId: string;
}
export interface MessagePage {
  messages: ChatMessage[];
  nextBefore: string | null;
  change: string;
  hasMore: boolean;
}
export interface Invitation {
  id: string;
  conversationId: string;
  name: string;
  inviter: string;
}
export type ChatAck<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export interface MessageNotice {
  conversationId: string;
  messageId: string;
  seq: string;
  authorId: string;
  kind: Conversation['kind'];
  mention: boolean;
  reply?: boolean;
  preferences?: NoticePreferences;
}
// Usernames are ASCII letters, digits and underscores. Email-like text is not a mention.
export function mentionsUser(body: string, username: string): boolean {
  if (!/^[a-z0-9_]{3,32}$/i.test(username)) return false;
  return mentionUsernames(body).includes(username.toLowerCase());
}
export function mentionUsernames(body: string): string[] {
  const names = new Set<string>();
  const tokens = /(^|[^\p{L}\p{N}_@])@([a-zA-Z0-9_]{3,32})(?![\p{L}\p{N}_])/gu;
  for (const match of body.matchAll(tokens)) names.add(match[2]!.toLowerCase());
  return [...names];
}

export type ConversationUnread = Pick<
  Conversation,
  'id' | 'unreadCount' | 'mentionCount' | 'lastReadSeq' | 'activity'
>;
export { safeHttpUrl } from './http-url.js';
export { chatMetadataLimits, normalizedChatName } from './chat-metadata.js';
export { chatEmoji, isChatEmoji, type ChatEmoji } from './emoji.js';
export type { ChannelReference } from './channel-references.js';
export { buildGiphySearchUrl, parseGiphySearchPage } from './gif-search.js';
export { buildKlipySearchUrl, parseKlipySearchPage, klipyMediaHosts } from './klipy-search.js';
export type {
  GifProvider,
  GifSearchRequest,
  GifSearchResult,
  GifSearchPage,
  GifProvidersResponse,
} from './gif-search.js';
export type {
  NoticePreferences,
  ConversationAlertMode,
  NotificationTarget,
} from './notifications.js';
export type {
  ConversationAlertPreference,
  SenderAlertPreference,
  SenderAlertPreferencePage,
} from './notifications.js';
import type { NoticePreferences } from './notifications.js';
