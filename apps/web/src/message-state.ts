import type { ChatMessage } from '@tricord/shared';
export function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const map = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const old = map.get(item.id);
    if (!old || BigInt(item.change) >= BigInt(old.change)) map.set(item.id, item);
  }
  return [...map.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
}
