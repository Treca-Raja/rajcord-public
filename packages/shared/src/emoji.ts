export const chatEmoji = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '🥳',
  '😎',
  '🤔',
  '😅',
  '😢',
  '😭',
  '😮',
  '😴',
  '👍',
  '👎',
  '❤️',
  '💙',
  '💚',
  '🔥',
  '🎉',
  '🎮',
  '👋',
  '👏',
  '🙏',
  '💪',
  '✅',
  '❌',
  '👀',
  '🚀',
] as const;
export type ChatEmoji = string;
let supported: Set<string> | undefined;
export function isChatEmoji(value: unknown): value is ChatEmoji {
  if (typeof value !== 'string' || value.length > 64) return false;
  supported ??= new Set(unicode);
  return supported.has(value);
}
import unicode from 'emojibase-data/meta/unicode.json' with { type: 'json' };
