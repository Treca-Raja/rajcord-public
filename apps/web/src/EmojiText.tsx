import { Fragment, useState } from 'react';
import emojiRegex from 'emoji-regex';
import { emojiAssetPath } from './emoji-assets';

export function emojiParts(text: string) {
  const parts: { text: string; emoji: boolean }[] = [];
  let offset = 0;
  for (const match of text.matchAll(emojiRegex())) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index), emoji: false });
    parts.push({ text: match[0], emoji: true });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), emoji: false });
  return parts;
}
export function EmojiGlyph({ emoji }: { emoji: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="emoji-glyph"
      data-failed={failed}
      title={failed ? 'Emoji artwork unavailable' : undefined}
    >
      {!failed && (
        <img
          src={emojiAssetPath(emoji)}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      <span className="emoji-source">{emoji}</span>
    </span>
  );
}
export function EmojiText({ text }: { text: string }) {
  return (
    <>
      {emojiParts(text).map((part, index) =>
        part.emoji ? (
          <EmojiGlyph key={index + part.text} emoji={part.text} />
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
