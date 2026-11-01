export const emojiAssetPrefix = '/emoji/17-b6b55fef/';
export function emojiAssetPath(emoji: string) {
  const sequence = emoji.includes('\u200d') ? emoji : emoji.replace(/\uFE0F/g, '');
  return (
    emojiAssetPrefix +
    [...sequence].map((character) => character.codePointAt(0)!.toString(16)).join('-') +
    '.svg'
  );
}
