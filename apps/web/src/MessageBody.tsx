import { safeHttpUrl } from '@tricord/shared';

export type MessagePart = { text: string; href?: string };

function trimUrl(value: string): string {
  let result = value;
  while (result) {
    if (/[.,!?;:]$/.test(result)) result = result.slice(0, -1);
    else {
      const closing = result.at(-1)!;
      const opening = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[closing];
      if (opening && result.split(closing).length > result.split(opening).length)
        result = result.slice(0, -1);
      else break;
    }
  }
  return result;
}

export function messageParts(body: string): MessagePart[] {
  // Code stays literal. Markdown is deliberately limited to links, never HTML.
  const tokens =
    /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[([^\]\n]+)\]\(((?:[^\s()<>]|\([^\s()<>]*\))*)\)|https?:\/\/[^\s<>"'`]+/gi;
  const parts: MessagePart[] = [];
  let offset = 0;
  for (const match of body.matchAll(tokens)) {
    const start = match.index;
    if (start > offset) parts.push({ text: body.slice(offset, start) });
    const raw = match[0];
    if (raw.startsWith('`') || raw.startsWith('![')) parts.push({ text: raw });
    else if (match[1] !== undefined) {
      const href = safeHttpUrl(match[2]!);
      parts.push(href ? { text: match[1], href } : { text: raw });
    } else {
      const text = trimUrl(raw);
      const href = /[\p{L}\p{N}_:/@]/u.test(body[start - 1] ?? '') ? undefined : safeHttpUrl(text);
      parts.push(href ? { text, href } : { text: raw });
      if (href && text.length < raw.length) parts.push({ text: raw.slice(text.length) });
    }
    offset = start + raw.length;
  }
  if (offset < body.length) parts.push({ text: body.slice(offset) });
  return parts;
}

export function MessageBody({ body }: { body: string }) {
  return (
    <p className="message-body">
      {messageParts(body).map((part, index) =>
        part.href ? (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </p>
  );
}
