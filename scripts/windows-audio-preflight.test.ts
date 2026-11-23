import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AudioPermissionUnconfirmed,
  audioConsoleDiagnostic,
  confirmAudioPermissions,
  requireAudioTerminal,
} from './windows-audio-preflight.mjs';

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  output.resume();
  return { input, output };
}

describe('interactive Windows audio preflight', () => {
  it('rejects redirected input or a hidden prompt', () => {
    const { input, output } = terminal();
    expect(() => requireAudioTerminal(new PassThrough(), output)).toThrow(
      AudioPermissionUnconfirmed,
    );
    expect(() => requireAudioTerminal(input, new PassThrough())).toThrow(
      AudioPermissionUnconfirmed,
    );
  });

  it('accepts an explicit confirmation in the terminal', async () => {
    const io = terminal();
    const confirmation = confirmAudioPermissions('Audio preflight', io);
    io.input.write('GRANTED\r');
    await expect(confirmation).resolves.toBeUndefined();
  });

  it('keeps routine buffer-release messages from scrolling the prompt out of view', () => {
    const release = 'wasapi stage=IAudioCaptureClient.ReleaseBuffer time_ms=42 hr=';
    expect(audioConsoleDiagnostic(release + '0x00000000', false)).toBe(false);
    expect(audioConsoleDiagnostic(release + '0x00000000', true)).toBe(false);
    expect(audioConsoleDiagnostic(release + '0x88890010', false)).toBe(true);
    expect(
      audioConsoleDiagnostic('wasapi stage=IAudioClient.Start time_ms=42 hr=0x00000000', false),
    ).toBe(true);
  });

  it('requires readiness to trigger audio access before asking whether it was granted', async () => {
    const first = terminal();
    const earlyGrant = confirmAudioPermissions('Warm-up', { ...first, warmup: true });
    first.input.write('GRANTED\r');
    await expect(earlyGrant).rejects.toThrow(AudioPermissionUnconfirmed);

    const second = terminal();
    const start = confirmAudioPermissions('Warm-up', { ...second, warmup: true });
    second.input.write('READY\r');
    await expect(start).resolves.toBeUndefined();
  });

  it('treats a declined confirmation as inconclusive', async () => {
    const io = terminal();
    const confirmation = confirmAudioPermissions('Audio preflight', io);
    io.input.write('prompt pending\r');
    await expect(confirmation).rejects.toThrow('result inconclusive');
  });

  it('fails closed on terminal EOF and on a missed deadline', async () => {
    const io = terminal();
    const confirmation = confirmAudioPermissions('Audio preflight', io);
    io.input.end();
    await expect(confirmation).rejects.toThrow('result inconclusive');

    const controller = new AbortController();
    const timeout = confirmAudioPermissions('Audio preflight', {
      ...terminal(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(timeout).rejects.toThrow('confirmation timed out');
  });
});
