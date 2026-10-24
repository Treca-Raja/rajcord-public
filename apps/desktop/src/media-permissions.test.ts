import { it, expect } from 'vitest';
import { trustedAudioRequest, trustedAudioCheck } from './media-permissions';
const target = 'http://127.0.0.1:3001';
it('permits only trusted top-frame microphone requests', () => {
  expect(trustedAudioRequest(target, target, true, 'media', ['audio'])).toBe(true);
  for (const types of [[], ['video'], ['audio', 'video']])
    expect(trustedAudioRequest(target, target, true, 'media', types)).toBe(false);
  expect(trustedAudioRequest(target, target, true, 'display-capture', ['audio'])).toBe(false);
});
it('rejects embedded and foreign permission requests', () => {
  expect(trustedAudioRequest(target, 'https://evil.test', true, 'media', ['audio'])).toBe(false);
  expect(trustedAudioRequest(target, target, false, 'media', ['audio'])).toBe(false);
  expect(trustedAudioRequest(target, 'invalid', true, 'media', ['audio'])).toBe(false);
});
it('permission checks never grant camera or display capture', () => {
  expect(trustedAudioCheck(target, target, true, 'media', 'audio')).toBe(true);
  expect(trustedAudioCheck(target, target, true, 'speaker-selection')).toBe(true);
  expect(trustedAudioCheck(target, target, true, 'media', 'video')).toBe(false);
  expect(trustedAudioCheck(target, target, true, 'display-capture')).toBe(false);
  expect(trustedAudioCheck(target, target, false, 'speaker-selection')).toBe(false);
});
