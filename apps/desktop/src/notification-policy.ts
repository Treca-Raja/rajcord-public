export function validNotice(value: unknown): value is { conversationId: string; mention: boolean } {
  if (!value || typeof value !== 'object') return false;
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
