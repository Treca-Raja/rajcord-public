import { safeHttpUrl, type ChannelReference } from '@tricord/shared';
import { Fragment } from 'react';
import { EmojiText } from './EmojiText';
import { channelReferenceParts } from './channel-references';

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

function highlighted(text: string, mentions: { username: string }[]) {
  const names = new Set(mentions.map((mention) => mention.username.toLowerCase()));
  return text
    .split(/((?:^|[^\p{L}\p{N}_@])@[a-zA-Z0-9_]{3,32}(?![\p{L}\p{N}_]))/gu)
    .map((part, index) => {
      const match = part.match(/^([^\p{L}\p{N}_@]?)@([a-zA-Z0-9_]{3,32})$/u);
      return match && names.has(match[2]!.toLowerCase()) ? (
        <span key={index}>
          {match[1]}
          <mark>@{match[2]}</mark>
        </span>
      ) : (
        <EmojiText text={part} key={index} />
      );
    });
}
export function MessageBody({
  body,
  mentions = [],
  channels = [],
  onChannel,
}: {
  body: string;
  mentions?: { username: string }[];
  channels?: ChannelReference[];
  onChannel?: (channel: ChannelReference) => void;
}) {
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
            {highlighted(part.text, mentions)}
          </a>
        ) : (
          <Fragment key={index}>
            {channelReferenceParts(part.text, channels).map((reference, position) =>
              reference.channel && onChannel ? (
                <button
                  type="button"
                  className="channel-reference"
                  key={position}
                  onClick={() => onChannel(reference.channel!)}
                  aria-label={
                    'Open ' +
                    (reference.channel.kind === 'channel' ? 'text' : 'voice') +
                    ' channel ' +
                    reference.channel.name
                  }
                >
                  {reference.channel.kind === 'channel' ? '#' : '◖'} {reference.channel.name}
                </button>
              ) : (
                <Fragment key={position}>{highlighted(reference.text, mentions)}</Fragment>
              ),
            )}
          </Fragment>
        ),
      )}
    </p>
  );
}
