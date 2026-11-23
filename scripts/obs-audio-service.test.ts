import { describe, expect, it } from 'vitest';
import { checkWindowsAudioSnapshot } from './obs-audio-service.mjs';

const healthy = { Audiosrv: 'Running', AudioEndpointBuilder: 'Running', terminationRecord: 41 };

describe('OBS fixture Windows Audio checks', () => {
  it('accepts running services and retains the termination record for later checks', () => {
    expect(checkWindowsAudioSnapshot(healthy, undefined)).toBe(41);
    expect(checkWindowsAudioSnapshot(healthy, 41)).toBe(41);
  });

  it.each(['Audiosrv', 'AudioEndpointBuilder'])('rejects a stopped %s', (service) => {
    expect(() => checkWindowsAudioSnapshot({ ...healthy, [service]: 'Stopped' }, 41)).toThrow(
      `${service}=Stopped`,
    );
  });

  it('detects a termination even after automatic service recovery', () => {
    expect(() => checkWindowsAudioSnapshot({ ...healthy, terminationRecord: 42 }, 41)).toThrow(
      'Windows Audio termination event 42',
    );
  });

  it('does not treat expiry of an old event from the query window as a termination', () => {
    expect(checkWindowsAudioSnapshot({ ...healthy, terminationRecord: 0 }, 41)).toBe(0);
  });
});
