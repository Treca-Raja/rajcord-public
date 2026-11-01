import type { VoiceState } from './voice-controller';

export type SoundKind = 'join' | 'leave' | 'message';
export type SoundPreferences = { enabled: boolean; volume: number };
export const defaultSoundPreferences: SoundPreferences = { enabled: false, volume: 0.35 };
export const soundPreferenceKey = (userId: string) => 'rajcord-sounds:' + userId;

export function parseSoundPreferences(value: string | null): SoundPreferences {
  if (value === null) return { ...defaultSoundPreferences };
  const saved: unknown = JSON.parse(value);
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('enabled' in saved) ||
    typeof saved.enabled !== 'boolean' ||
    !('volume' in saved) ||
    typeof saved.volume !== 'number' ||
    !Number.isFinite(saved.volume) ||
    saved.volume < 0 ||
    saved.volume > 1
  )
    throw new Error('Invalid sound preferences.');
  return { enabled: saved.enabled, volume: saved.volume };
}

export class VoiceSoundTracker {
  private channel: string | null = null;
  private synchronized = false;
  private peers = new Set<string>();
  constructor(private userId: string) {}
  reset() {
    this.channel = null;
    this.synchronized = false;
    this.peers.clear();
  }
  update(voice: VoiceState): SoundKind | undefined {
    if (voice.status === 'idle') {
      const left = this.channel !== null;
      this.reset();
      return left ? 'leave' : undefined;
    }
    if (voice.status !== 'connected' || !voice.channelId) {
      this.synchronized = false;
      return;
    }
    const peers = new Set(voice.participants.filter((p) => p.id !== this.userId).map((p) => p.id));
    let cue: SoundKind | undefined;
    if (this.channel !== voice.channelId) cue = 'join';
    else if (this.synchronized) {
      if ([...peers].some((id) => !this.peers.has(id))) cue = 'join';
      else if ([...this.peers].some((id) => !peers.has(id))) cue = 'leave';
    }
    this.channel = voice.channelId;
    this.peers = peers;
    this.synchronized = true;
    return cue;
  }
}

// Short, local PCM tones: no downloaded assets or third-party audio requests.
export function soundData(kind: SoundKind) {
  const notes = { join: [523, 659], leave: [659, 440], message: [784, 784] }[kind];
  const rate = 22050,
    length = Math.floor(rate * 0.28);
  const bytes = new Uint8Array(44 + length * 2),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => {
      bytes[offset + i] = c.charCodeAt(0);
    });
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const segment = (i / rate) % 0.14,
      note = notes[i < length / 2 ? 0 : 1]!;
    const envelope = Math.max(0, Math.min(segment / 0.01, (0.12 - segment) / 0.04, 1));
    view.setInt16(
      44 + i * 2,
      Math.round(8000 * envelope * Math.sin((2 * Math.PI * note * i) / rate)),
      true,
    );
  }
  return bytes;
}

export class ApplicationSoundPlayer {
  private preferences = { ...defaultSoundPreferences };
  private output = '';
  private unavailable = false;
  private deafened = false;
  private generation = 0;
  private active?: HTMLAudioElement;
  private lastPlayed = -Infinity;
  private sources = new Map<SoundKind, string>();
  private tracker: VoiceSoundTracker;
  constructor(
    userId: string,
    private onError: (message: string) => void,
    private createAudio = () => {
      const audio = document.createElement('audio');
      document.body.appendChild(audio);
      return audio;
    },
  ) {
    this.tracker = new VoiceSoundTracker(userId);
  }
  configure(preferences: SoundPreferences) {
    if (
      this.preferences.enabled !== preferences.enabled ||
      this.preferences.volume !== preferences.volume
    )
      this.stop();
    this.preferences = { ...preferences };
  }
  updateVoice(voice: VoiceState) {
    if (
      this.output !== voice.output ||
      this.unavailable !== voice.outputMissing ||
      this.deafened !== voice.deafened
    )
      this.stop();
    this.output = voice.output;
    this.unavailable = voice.outputMissing;
    this.deafened = voice.deafened;
    const cue = this.tracker.update(voice);
    if (cue) void this.play(cue);
  }
  stop() {
    this.generation++;
    if (this.active) {
      this.active.muted = true;
      this.active.pause();
      this.active.remove();
      this.active = undefined;
    }
  }
  resetVoice() {
    this.stop();
    this.tracker.reset();
    this.output = '';
    this.unavailable = false;
    this.deafened = false;
  }
  dispose() {
    this.resetVoice();
    this.preferences.enabled = false;
    for (const source of this.sources.values()) URL.revokeObjectURL(source);
    this.sources.clear();
  }
  preview() {
    this.lastPlayed = -Infinity;
    return this.play('message');
  }
  async play(kind: SoundKind): Promise<boolean> {
    if (!this.preferences.enabled || !this.preferences.volume || this.deafened || this.unavailable)
      return false;
    if (!this.output) {
      this.onError('Choose speakers in Audio controls before playing sounds.');
      return false;
    }
    // Coalesce bursts; never queue old alerts or replay them after recovery.
    if (Date.now() - this.lastPlayed < 300) return false;
    this.lastPlayed = Date.now();
    this.stop();
    const generation = this.generation,
      output = this.output;
    const audio = this.createAudio();
    this.active = audio;
    audio.dataset.appSound = kind;
    audio.volume = this.preferences.volume;
    audio.muted = true;
    const current = () => generation === this.generation && this.active === audio;
    audio.onended = () => {
      if (current()) this.stop();
    };
    try {
      let source = this.sources.get(kind);
      if (!source) {
        source = URL.createObjectURL(new Blob([soundData(kind)], { type: 'audio/wav' }));
        this.sources.set(kind, source);
      }
      audio.src = source;
      if (typeof audio.setSinkId !== 'function')
        throw new Error('This browser cannot select sound output. Use Edge or the desktop app.');
      await audio.setSinkId(output);
      if (!current()) return false;
      audio.muted = false;
      await audio.play();
      if (!current()) {
        audio.pause();
        return false;
      }
      return true;
    } catch (error) {
      audio.muted = true;
      audio.pause();
      audio.remove();
      if (current()) {
        this.stop();
        this.onError(
          'Sound playback blocked or unavailable. Check speakers, then click Preview sound to try again. ' +
            (error as Error).message,
        );
      }
      return false;
    }
  }
}
