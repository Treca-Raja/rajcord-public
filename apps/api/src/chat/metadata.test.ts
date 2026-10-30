import { expect, it } from 'vitest';
import { channelTopic, chatName, checkMetadataRevision, metadataPosition } from './metadata.js';

it('validates approved metadata limits without truncating content', () => {
  expect(chatName('  Cafe\u0301  🎮 ', 80, 'Channel name').name).toBe('Café 🎮');
  expect(channelTopic('  Cafe\u0301  ')).toBe('Café');
  expect(channelTopic('🎮'.repeat(500))).toHaveLength(1000);
  expect(channelTopic(undefined)).toBe('');
  for (const value of ['🎮'.repeat(501), 'line\nbreak', '\u202e', 42, null])
    expect(() => channelTopic(value)).toThrow();
  expect(() => chatName(' ', 80, 'Channel name')).toThrow();
});

it('requires bounded integer positions and exact revision tokens', () => {
  for (const value of [0, 2147483647]) expect(metadataPosition(value)).toBe(value);
  for (const value of [-1, 2147483648, 1.5, '2', null, NaN, Infinity])
    expect(() => metadataPosition(value)).toThrow();
  expect(() => checkMetadataRevision('12', 12n)).not.toThrow();
  for (const value of [undefined, '11', 12, '-1', 'bad', '1'.repeat(20)])
    expect(() => checkMetadataRevision(value, 12n)).toThrow();
});
