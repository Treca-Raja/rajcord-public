import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationSoundPlayer,
  VoiceSoundTracker,
  parseSoundPreferences,
  soundData,
} from './application-sounds';
import type { VoiceState } from './voice-controller';

function voice(values: Partial<VoiceState> = {}): VoiceState {
  return {
    status: 'idle',
    channelId: null,
    input: 'mic',
    output: 'speaker',
    inputMissing: false,
    outputMissing: false,
    muted: true,
    deafened: false,
    error: '',
    participants: [],
    ...values,
  };
}
function connected(ids = ['me', 'friend']): VoiceState {
  return voice({
    status: 'connected',
    channelId: 'room',
    participants: ids.map((id) => ({ id, name: id, muted: true, speaking: false, volume: 1 })),
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('voice cue membership policy', () => {
  it('plays one self-join, ignores the initial roster, and reports only actual membership changes', () => {
    const tracker = new VoiceSoundTracker('me');
    expect(tracker.update(voice())).toBeUndefined();
    expect(tracker.update(voice({ status: 'joining', channelId: 'room' }))).toBeUndefined();
    expect(tracker.update(connected())).toBe('join');
    expect(tracker.update(connected())).toBeUndefined();
    expect(tracker.update(connected(['me', 'friend', 'other']))).toBe('join');
    expect(tracker.update(connected(['me', 'friend', 'other']))).toBeUndefined();
    expect(tracker.update(connected(['me', 'other']))).toBe('leave');
    expect(tracker.update(voice())).toBe('leave');
    expect(tracker.update(voice())).toBeUndefined();
  });
  it('does not turn reconnect snapshots or failed joins into membership sounds', () => {
    const tracker = new VoiceSoundTracker('me');
    tracker.update(voice({ status: 'joining', channelId: 'room' }));
    expect(tracker.update(voice())).toBeUndefined();
    tracker.update(connected());
    expect(tracker.update(voice({ status: 'reconnecting', channelId: 'room' }))).toBeUndefined();
    expect(tracker.update(connected(['me', 'new']))).toBeUndefined();
    expect(tracker.update(connected(['me', 'new', 'live']))).toBe('join');
    tracker.reset();
    expect(tracker.update(voice())).toBeUndefined();
  });
});

function setup() {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const error = vi.fn();
  const elements: ReturnType<typeof audio>[] = [];
  function audio() {
    return {
      dataset: {} as Record<string, string>,
      src: '',
      volume: 1,
      muted: false,
      onended: null as (() => void) | null,
      setSinkId: vi.fn().mockResolvedValue(undefined),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      remove: vi.fn(),
    };
  }
  const create = vi.fn(() => {
    const element = audio();
    elements.push(element);
    return element as unknown as HTMLAudioElement;
  });
  const player = new ApplicationSoundPlayer('me', error, create);
  player.updateVoice(voice());
  return { player, error, create, elements };
}
describe('application sound playback', () => {
  it('starts silent and never creates media until explicitly enabled', async () => {
    const { player, create } = setup();
    expect(await player.play('message')).toBe(false);
    player.updateVoice(connected());
    expect(create).not.toHaveBeenCalled();
    player.configure({ enabled: true, volume: 0.25 });
    expect(create).not.toHaveBeenCalled();
    expect(await player.play('message')).toBe(true);
  });
  it('routes the exact selected sink before playback and bounds bursts to one element', async () => {
    const { player, elements, create } = setup();
    player.configure({ enabled: true, volume: 0.25 });
    await player.play('message');
    const first = elements[0]!;
    expect(first.setSinkId).toHaveBeenCalledWith('speaker');
    expect(first.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(
      first.play.mock.invocationCallOrder[0]!,
    );
    expect(first.volume).toBe(0.25);
    expect(first.src).toBe('blob:fixture');
    expect(await player.play('join')).toBe(false);
    expect(create).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(301);
    await player.play('leave');
    expect(first.pause).toHaveBeenCalled();
    expect(first.remove).toHaveBeenCalled();
    elements[1]!.onended!();
    expect(elements[1]!.remove).toHaveBeenCalled();
  });
  it('stops on deafen, output loss, disabling and disposal without default-device fallback', async () => {
    const { player, create, elements } = setup();
    player.configure({ enabled: true, volume: 0.4 });
    await player.play('message');
    player.updateVoice(voice({ deafened: true }));
    expect(elements[0]!.muted).toBe(true);
    expect(elements[0]!.pause).toHaveBeenCalled();
    vi.advanceTimersByTime(301);
    expect(await player.play('join')).toBe(false);
    player.updateVoice(voice({ outputMissing: true }));
    expect(await player.play('join')).toBe(false);
    player.configure({ enabled: false, volume: 0.4 });
    expect(await player.play('message')).toBe(false);
    player.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
    expect(await player.play('leave')).toBe(false);
    expect(create).toHaveBeenCalledOnce();
  });
  it('cannot revive a sound after a pending sink selection is superseded', async () => {
    const { player, elements } = setup();
    player.configure({ enabled: true, volume: 0.4 });
    await player.play('message');
    vi.advanceTimersByTime(301);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = () => {
      const element = {
        ...elements[0]!,
        dataset: {},
        setSinkId: vi.fn(() => pending),
        play: vi.fn(),
        pause: vi.fn(),
        remove: vi.fn(),
      };
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    };
    const waiting = new ApplicationSoundPlayer('me', vi.fn(), create);
    waiting.configure({ enabled: true, volume: 0.4 });
    waiting.updateVoice(voice());
    const playing = waiting.play('message');
    waiting.updateVoice(voice({ output: 'replacement' }));
    finish();
    expect(await playing).toBe(false);
    expect(elements[1]!.play).not.toHaveBeenCalled();
    expect(elements[1]!.muted).toBe(true);
  });
  it('surfaces missing/unsupported sinks and denied playback, with explicit retry but no replay', async () => {
    const { player, create, error, elements } = setup();
    player.configure({ enabled: true, volume: 0.4 });
    player.updateVoice(voice({ output: '' }));
    expect(await player.play('message')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Choose speakers'));
    expect(create).not.toHaveBeenCalled();
    player.updateVoice(voice());
    await player.play('message');
    vi.advanceTimersByTime(301);
    elements[0]!.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    const denied = new ApplicationSoundPlayer(
      'me',
      error,
      () => elements[0] as unknown as HTMLAudioElement,
    );
    denied.configure({ enabled: true, volume: 0.4 });
    denied.updateVoice(voice());
    expect(await denied.play('message')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Preview sound'));
    vi.advanceTimersByTime(301);
    expect(await denied.play('message')).toBe(true);
    vi.advanceTimersByTime(301);
    elements[0]!.setSinkId = undefined as unknown as (typeof elements)[0]['setSinkId'];
    expect(await denied.play('join')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot select'));
  });
  it('late playback completion cannot revive audio after logout/disposal', async () => {
    const { player, elements, error } = setup();
    player.configure({ enabled: true, volume: 0.4 });
    await player.preview();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const element = elements[0]!;
    element.play.mockReturnValueOnce(pending);
    const late = new ApplicationSoundPlayer(
      'me',
      error,
      () => element as unknown as HTMLAudioElement,
    );
    late.configure({ enabled: true, volume: 0.4 });
    late.updateVoice(voice());
    const playback = late.preview();
    await Promise.resolve();
    late.dispose();
    finish();
    expect(await playback).toBe(false);
    expect(element.muted).toBe(true);
    expect(element.pause).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(await late.preview()).toBe(false);
  });
  it('sink permission failure never tries playback or switches to the default sink', async () => {
    const { player, elements, error } = setup();
    player.configure({ enabled: true, volume: 0.4 });
    await player.preview();
    const element = elements[0]!;
    element.setSinkId.mockRejectedValueOnce(new Error('NotAllowedError'));
    element.play.mockClear();
    const denied = new ApplicationSoundPlayer(
      'me',
      error,
      () => element as unknown as HTMLAudioElement,
    );
    denied.configure({ enabled: true, volume: 0.4 });
    denied.updateVoice(voice({ output: 'selected-speaker' }));
    expect(await denied.preview()).toBe(false);
    expect(element.setSinkId).toHaveBeenLastCalledWith('selected-speaker');
    expect(element.play).not.toHaveBeenCalled();
    expect(element.muted).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NotAllowedError'));
  });
  it('zero volume suppresses all cues and preference validation fails closed', async () => {
    const { player, create } = setup();
    player.configure({ enabled: true, volume: 0 });
    expect(await player.play('message')).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(parseSoundPreferences(null)).toEqual({ enabled: false, volume: 0.35 });
    expect(parseSoundPreferences('{"enabled":true,"volume":0.4}')).toEqual({
      enabled: true,
      volume: 0.4,
    });
    for (const value of [
      'bad',
      '{}',
      'null',
      '{"enabled":"on","volume":0.5}',
      '{"enabled":true,"volume":2}',
      '{"enabled":true,"volume":-1}',
    ])
      expect(() => parseSoundPreferences(value)).toThrow();
  });
  it('generates three distinct short PCM sounds', () => {
    const sounds = (['join', 'leave', 'message'] as const).map((kind) => soundData(kind));
    expect(new Set(sounds.map((bytes) => Array.from(bytes).join(','))).size).toBe(3);
    for (const bytes of sounds) {
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
      expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
      const header = new DataView(bytes.buffer);
      expect(header.getUint32(4, true)).toBe(bytes.length - 8);
      expect(header.getUint32(40, true)).toBe(bytes.length - 44);
      expect(header.getUint16(20, true)).toBe(1);
      expect(header.getUint16(34, true)).toBe(16);
      expect(bytes.length).toBeLessThan(14000);
    }
  });
});
