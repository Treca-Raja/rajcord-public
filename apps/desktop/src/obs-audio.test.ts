import { expect, it } from 'vitest';
import type { Screen } from 'electron';
import type { NativeCaptureSource } from './native-capture.js';
import { obsTarget, nativeCaptureIdentity } from './obs-screen.js';

const desktop = {
  getAllDisplays: () => [{ id: 81, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } }],
  dipToScreenRect: (_window: null, bounds: unknown) => bounds,
} as unknown as Screen;

function source(id: string, extra: Partial<NativeCaptureSource> = {}): NativeCaptureSource {
  return {
    id,
    name: 'Owned test source',
    video: { id, name: 'Owned test source', display_id: '81' } as NativeCaptureSource['video'],
    ...extra,
  };
}

it('selects only the exact consented application process for native WASAPI', () => {
  const application = source('window:444:0', {
    applicationAudioId: 'applicationLoopback:2323',
    applicationIdentity: '2323:638459123456780000',
  });
  expect(obsTarget(application, desktop, 'source')).toEqual([
    'window',
    '444',
    'app',
    '2323',
    '638459123456780000',
    String(process.pid),
  ]);
  expect(obsTarget(application, desktop, 'none')).toEqual([
    'window',
    '444',
    'identity',
    '2323',
    '638459123456780000',
  ]);
  expect(() => obsTarget(application, desktop, 'system')).toThrow();
  for (const properties of [
    { applicationIdentity: undefined },
    { applicationIdentity: '2345:638459123456780000' },
    { applicationIdentity: '2323:0' },
    {
      applicationAudioId: `applicationLoopback:${process.pid}` as const,
      applicationIdentity: `${process.pid}:638459123456780000`,
    },
  ]) {
    expect(() => obsTarget({ ...application, ...properties }, desktop, 'application')).toThrow();
  }
});

it('binds system audio to an exact display and excludes the Rajcord process tree', () => {
  const monitor = source('screen:1:0');
  const capture = ['monitor', '-1920', '0', '0', '1080'];
  expect(obsTarget(monitor, desktop, 'source')).toEqual([
    ...capture,
    'system',
    String(process.pid),
  ]);
  expect(obsTarget(monitor, desktop, 'none')).toEqual(capture);
  expect(nativeCaptureIdentity(monitor, capture, 1)).not.toEqual(
    nativeCaptureIdentity(monitor, capture, 2),
  );
  expect(() => obsTarget(monitor, desktop, 'application')).toThrow();
  expect(() =>
    obsTarget(
      {
        ...monitor,
        video: {
          id: monitor.id,
          name: 'Other monitor',
          display_id: '82',
        } as NativeCaptureSource['video'],
      },
      desktop,
      'system',
    ),
  ).toThrow();
});
