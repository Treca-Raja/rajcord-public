import { afterEach, expect, it, vi } from 'vitest';
import { NotificationAudio } from './notification-audio';
afterEach(() => vi.unstubAllGlobals());
it('never creates or resumes audio without explicit interaction and reports autoplay recovery', async () => {
  const oscillator = {
    type: '',
    frequency: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const context = {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    createOscillator: () => oscillator,
    createGain: () => gain,
  };
  const constructor = vi.fn(function () {
    return context;
  });
  vi.stubGlobal('AudioContext', constructor);
  const audio = new NotificationAudio();
  expect(constructor).not.toHaveBeenCalled();
  expect(() => audio.play(0.5)).toThrow('Enable / test sound');
  await audio.unlock();
  expect(context.resume).toHaveBeenCalledOnce();
  audio.play(0);
  expect(oscillator.start).not.toHaveBeenCalled();
  audio.play(0.5);
  expect(oscillator.start).toHaveBeenCalledOnce();
  expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.075, 0);
  context.state = 'suspended';
  expect(() => audio.play(0.5)).toThrow('recover');
  audio.close();
  expect(context.close).toHaveBeenCalledOnce();
});
it('surfaces blocked autoplay rather than pretending sound was enabled', async () => {
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'suspended';
      async resume() {}
    },
  );
  await expect(new NotificationAudio().unlock()).rejects.toThrow('Sound is blocked');
});
