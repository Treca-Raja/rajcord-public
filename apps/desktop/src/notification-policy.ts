export function validNotice(value: unknown): value is { conversationId: string; mention: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 2 &&
    typeof data.mention === 'boolean' &&
    typeof data.conversationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data.conversationId,
    )
  );
}
export function trustedNoticeFrame(target: string, url: string, mainFrame: boolean) {
  try {
    return mainFrame && new URL(url).origin === new URL(target).origin;
  } catch {
    return false;
  }
}
export type NativeNotificationTarget = {
  conversationId: string;
  messageId?: string;
  thread?: boolean;
};
export type NativeNotificationResult =
  | { status: 'shown' }
  | { status: 'coalesced'; count: number }
  | { status: 'unavailable' | 'invalid' };
export type NativeNotificationNotice = {
  version: 2;
  target: NativeNotificationTarget;
  mention: boolean;
};
export function nativeNotificationResponse(modern: boolean, result: NativeNotificationResult) {
  return modern ? result : result.status === 'shown';
}
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validNotificationTarget(value: unknown): value is NativeNotificationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).every((key) => ['conversationId', 'messageId', 'thread'].includes(key)) &&
    typeof data.conversationId === 'string' &&
    identifier.test(data.conversationId) &&
    (data.messageId === undefined ||
      (typeof data.messageId === 'string' && identifier.test(data.messageId))) &&
    (data.thread === undefined || typeof data.thread === 'boolean') &&
    (data.thread !== true || data.messageId !== undefined)
  );
}
export function validNativeNotice(value: unknown): value is NativeNotificationNotice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 3 &&
    data.version === 2 &&
    typeof data.mention === 'boolean' &&
    validNotificationTarget(data.target)
  );
}
export function canCoalesceNativeNotice(
  previous: { at: number; active: boolean } | undefined,
  now: number,
) {
  return !!previous && previous.active && now >= previous.at && now - previous.at < 3000;
}
