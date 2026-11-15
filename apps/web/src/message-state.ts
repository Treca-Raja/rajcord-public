import type { ChatMessage, MessageReference } from '@tricord/shared';
type LegacyMessage = Omit<
  ChatMessage,
  | 'featureVersion'
  | 'contextChange'
  | 'replyTo'
  | 'threadRoot'
  | 'replyCount'
  | 'pinned'
  | 'reactions'
  | 'mentions'
>;
export function compatibleMessage(item: ChatMessage | LegacyMessage): ChatMessage {
  if ('featureVersion' in item) return item;
  return {
    ...item,
    featureVersion: 1,
    contextChange: item.change,
    replyTo: null,
    threadRoot: null,
    replyCount: 0,
    pinned: false,
    reactions: [],
    mentions: [],
  };
}
export function mergeMessages(
  previous: ChatMessage[],
  incoming: ChatMessage[],
  includeNew: boolean | ((message: ChatMessage) => boolean) = true,
) {
  incoming = incoming.map(compatibleMessage);
  const map = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const old = map.get(item.id);
    if (
      (!old && (typeof includeNew === 'function' ? includeNew(item) : includeNew)) ||
      (old && BigInt(item.change) >= BigInt(old.change))
    ) {
      map.set(
        item.id,
        old && BigInt(item.contextChange) < BigInt(old.contextChange)
          ? {
              ...item,
              contextChange: old.contextChange,
              replyTo: old.replyTo,
              threadRoot: old.threadRoot,
              replyCount: old.replyCount,
            }
          : item,
      );
    }
  }
  const updates = new Map(incoming.map((item) => [item.id, item]));
  const reference = (old: MessageReference | null): MessageReference | null => {
    if (!old?.available) return old;
    const updated = updates.get(old.id);
    if (!updated || BigInt(updated.change) < BigInt(old.change)) return old;
    return {
      available: true,
      id: updated.id,
      seq: updated.seq,
      change: updated.change,
      author: updated.author,
      body: updated.body === null ? null : [...updated.body].slice(0, 200).join(''),
      deleted: updated.deleted,
    };
  };
  const rootCounts = new Map<string, { change: bigint; count: number }>();
  for (const item of incoming) {
    const rootId = item.threadRoot?.available
      ? item.threadRoot.id
      : item.threadRoot === null
        ? item.id
        : null;
    if (!rootId) continue;
    const old = rootCounts.get(rootId);
    if (!old || BigInt(item.contextChange) >= old.change)
      rootCounts.set(rootId, { change: BigInt(item.contextChange), count: item.replyCount });
  }
  return [...map.values()]
    .map((item) => {
      const rootId = item.threadRoot?.available
        ? item.threadRoot.id
        : item.threadRoot === null
          ? item.id
          : null;
      const update = rootId ? rootCounts.get(rootId) : undefined;
      return {
        ...item,
        replyTo: reference(item.replyTo),
        threadRoot: reference(item.threadRoot),
        replyCount:
          update && update.change >= BigInt(item.contextChange) ? update.count : item.replyCount,
        contextChange:
          update && update.change > BigInt(item.contextChange)
            ? String(update.change)
            : item.contextChange,
      };
    })
    .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
}
