import { expect, it } from 'vitest';
import {
  channelReferenceParts,
  composerSuggestions,
  encodeChannelReferences,
  referenceLabel,
} from './channel-references';
import { attemptFor, sendPayload } from './chat-state';

const text = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Game night 🎮',
  kind: 'channel' as const,
};
const voice = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'The lounge',
  kind: 'voice' as const,
};
it('offers readable text/voice choices and stores stable references only after explicit selection', () => {
  expect(composerSuggestions([], [text, voice], 'game')).toEqual([text]);
  expect(composerSuggestions([], [text, voice], 'the lo')).toEqual([voice]);
  const display = referenceLabel(text);
  expect(encodeChannelReferences('Meet in ' + display, [])).toBe('Meet in ' + display);
  const draft = {
    body: 'Meet in ' + display,
    replyToId: null,
    attempt: null,
    references: [{ display, channel: text }],
  };
  const pending = attemptFor(draft, () => 'first');
  expect(pending.body).toBe(draft.body);
  expect(sendPayload(pending).body).toBe('Meet in <#' + text.id + '>');
  expect(attemptFor({ ...draft, attempt: pending }, () => 'second')).toBe(pending);
  expect(
    attemptFor(
      { ...draft, attempt: pending, references: [{ display, channel: { ...text, id: voice.id } }] },
      () => 'second',
    ).clientId,
  ).toBe('second');
});
it('resolves current names without making references permission grants or mass alerts', () => {
  const parts = channelReferenceParts('<#' + text.id + '> <voice:' + voice.id + '>', [
    { ...text, name: 'Renamed' },
    voice,
  ]);
  expect(parts[0]).toMatchObject({ text: '#Renamed', channel: { id: text.id } });
  expect(parts[2]).toMatchObject({ text: '🔊The lounge', channel: voice });
  expect(channelReferenceParts('<#' + text.id + '>', [])).toEqual([
    { text: 'Channel unavailable', unavailable: true },
  ]);
  expect(channelReferenceParts('`<#' + text.id + '>`', [text])[0]?.text).toBe(
    '`<#' + text.id + '>`',
  );
});
