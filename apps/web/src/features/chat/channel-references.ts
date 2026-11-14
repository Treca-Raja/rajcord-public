import type { ChannelReference, Conversation } from '@tricord/shared';

export interface DraftChannelReference {
  display: string;
  channel: ChannelReference;
}
export type ComposerSuggestion =
  { kind: 'user'; id: string; username: string; displayName: string } | ChannelReference;

export function referenceLabel(channel: ChannelReference) {
  return (channel.kind === 'channel' ? '#' : '🔊') + channel.name;
}
export function referenceToken(channel: ChannelReference) {
  return channel.kind === 'channel' ? `<#${channel.id}>` : `<voice:${channel.id}>`;
}
export function encodeChannelReferences(body: string, references: DraftChannelReference[] = []) {
  if (!references.length) return body;
  const choices = [...references].sort((a, b) => b.display.length - a.display.length);
  const pattern = choices
    .map((reference) => reference.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return body
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part) =>
      part.startsWith('`')
        ? part
        : part.replace(
            new RegExp(`(^|[^\\p{L}\\p{N}_])(${pattern})(?=$|[\\s.,!?;:])`, 'gu'),
            (_match, prefix: string, label: string) =>
              prefix +
              referenceToken(choices.find((reference) => reference.display === label)!.channel),
          ),
    )
    .join('');
}
export function composerSuggestions(
  members: Conversation['members'],
  channels: ChannelReference[],
  query: string,
): ComposerSuggestion[] {
  const search = query.toLowerCase();
  const users: ComposerSuggestion[] = members
    .filter(
      (member) => member.status === 'approved' && member.username.toLowerCase().startsWith(search),
    )
    .map((member) => ({
      kind: 'user',
      id: member.id,
      username: member.username,
      displayName: member.displayName,
    }));
  const text = channels.filter(
    (channel) => channel.kind === 'channel' && channel.name.toLowerCase().startsWith(search),
  );
  const voice = channels.filter(
    (channel) => channel.kind === 'voice' && channel.name.toLowerCase().startsWith(search),
  );
  return query
    ? [...users, ...text, ...voice].slice(0, 10)
    : [...users.slice(0, 5), ...text.slice(0, 3), ...voice.slice(0, 2)];
}
const id = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function channelReferenceParts(text: string, channels: ChannelReference[]) {
  const parts: { text: string; channel?: ChannelReference; unavailable?: boolean }[] = [];
  const tokens = new RegExp(
    '```[\\s\\S]*?(?:```|$)|`[^`\\n]*`|<#(' + id + ')>|<voice:(' + id + ')>',
    'gi',
  );
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
    const target = match[1] ?? match[2];
    if (!target) parts.push({ text: match[0] });
    else {
      const channel = channels.find(
        (channel) =>
          channel.id.toLowerCase() === target.toLowerCase() &&
          channel.kind === (match[1] ? 'channel' : 'voice'),
      );
      parts.push(
        channel
          ? { text: referenceLabel(channel), channel }
          : { text: 'Channel unavailable', unavailable: true },
      );
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
