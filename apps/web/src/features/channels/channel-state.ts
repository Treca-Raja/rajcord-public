import type { ChannelCategory, Conversation } from '@tricord/shared';

export function channelCategories(
  conversations: Conversation[],
  loaded: ChannelCategory[],
): ChannelCategory[] {
  const categories = new Map<string, ChannelCategory>();
  for (const item of [
    ...loaded,
    ...conversations.flatMap((c) => (c.category ? [c.category] : [])),
  ]) {
    const previous = categories.get(item.id);
    if (!previous || BigInt(item.revision) >= BigInt(previous.revision))
      categories.set(item.id, item);
  }
  return [...categories.values()].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

export function channelFields(data: FormData) {
  return {
    name: String(data.get('name') ?? ''),
    topic: String(data.get('topic') ?? ''),
    categoryId: data.get('categoryId') || null,
    position: Number(data.get('position')),
  };
}
