import { expect, it } from 'vitest';
import {
  appliedProcessing,
  defaultProcessing,
  processingSettings,
  rawProcessing,
} from './voice-processing';

it('keeps standard and raw settings explicit and immutable', () => {
  expect(processingSettings(defaultProcessing)).toEqual({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  expect(processingSettings(rawProcessing)).toEqual({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  expect(Object.isFrozen(processingSettings(defaultProcessing))).toBe(true);
});
it.each([
  null,
  {},
  { echoCancellation: true },
  { ...defaultProcessing, autoGainControl: 'true' },
  { ...defaultProcessing, extra: true },
])('rejects malformed stored or requested processing settings: %#', (value) => {
  expect(() => processingSettings(value)).toThrow('Invalid microphone processing');
});
it('reports only settings the microphone actually returned, including disabled processing', () => {
  expect(appliedProcessing({ echoCancellation: false, noiseSuppression: true })).toEqual({
    echoCancellation: false,
    noiseSuppression: true,
  });
  expect(appliedProcessing({})).toEqual({});
});
