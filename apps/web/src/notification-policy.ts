import type { MessageNotice } from '@tricord/shared';
export function shouldNotify(
  notice: MessageNotice,
  userId: string,
  selected: string | null,
  focused: boolean,
) {
  return (
    notice.authorId !== userId &&
    !(focused && notice.conversationId === selected) &&
    (notice.kind !== 'channel' || notice.mention)
  );
}
export function notificationBody(mention: boolean) {
  return mention
    ? 'You were mentioned. Open Rajcord to read it.'
    : 'New private message. Open Rajcord to read it.';
}
