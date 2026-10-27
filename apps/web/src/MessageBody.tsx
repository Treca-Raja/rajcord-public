import { safeHttpUrl } from '@tricord/shared';

export type MessagePart = { text: string; href?: string };

function trimUrl(value: string, prefix: string): string {
  let result = value;
  let emphasis = prefix.match(/[*_~]+$/)?.[0] ?? '';
  while (result) {
    if (/[.,!?;:]$/.test(result)) result = result.slice(0, -1);
    else if (emphasis && result.endsWith(emphasis[0]!)) {
      result = result.slice(0, -1);
      emphasis = emphasis.slice(1);
    } else {
      const closing = result.at(-1)!;
      const opening = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[closing];
      if (opening && result.split(closing).length > result.split(opening).length)
        result = result.slice(0, -1);
      else break;
    }
  }
  return result;
}

function markdownDestination(body: string, start: number) {
  let depth = 1;
  let end = start;
  for (; end < body.length && body[end] !== '\n'; end++) {
    if (body[end] === '(') depth++;
    else if (body[end] === ')' && --depth === 0) {
      return { end: end + 1, destination: body.slice(start, end) };
    }
  }
  return { end, destination: undefined };
}

export function messageParts(body: string): MessagePart[] {
  // Code stays literal. Markdown is deliberately limited to links, never HTML.
  const tokens = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[([^[\]\n]+)\]\(|https?:\/\/[^\s<>"'`]+/gi;
  const parts: MessagePart[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(body))) {
    const start = match.index;
    if (start > offset) parts.push({ text: body.slice(offset, start) });
    let raw = match[0];
    if (match[1] !== undefined) {
      const { end, destination } = markdownDestination(body, tokens.lastIndex);
      raw = body.slice(start, end);
      tokens.lastIndex = end;
      const href =
        !raw.startsWith('![') && destination !== undefined ? safeHttpUrl(destination) : undefined;
      parts.push(href ? { text: match[1], href } : { text: raw });
    } else if (raw.startsWith('`')) parts.push({ text: raw });
    else {
      const prefix = body.slice(0, start);
      const text = trimUrl(raw, prefix);
      const boundary = prefix.replace(/[*_~]+$/, '').at(-1) ?? '';
      const href = /[\p{L}\p{N}_:/@]/u.test(boundary) ? undefined : safeHttpUrl(text);
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
          <a
            key={index}
            href={part.href}
            title={part.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </p>
  );
}
