import type { Room, LocalAudioTrack, RemoteTrack } from 'livekit-client';
export type VoiceChannel = {
  id: string;
  name: string;
  participants: { id: string; name: string }[];
};
export type VoiceState = {
  status: 'idle' | 'joining' | 'connected' | 'reconnecting';
  channelId: string | null;
  muted: boolean;
  deafened: boolean;
  input: string;
  output: string;
  inputMissing: boolean;
  outputMissing: boolean;
  error: string;
  participants: { id: string; name: string; speaking: boolean; muted: boolean; volume: number }[];
};
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Lease = { id: string; channelId: string; credential: string; useServerIceServers?: boolean };
export const concreteDevices = (devices: MediaDeviceInfo[], kind: MediaDeviceKind) =>
  devices.filter(
    (d) => d.kind === kind && d.deviceId && !['default', 'communications'].includes(d.deviceId),
  );
export class VoiceController {
  state: VoiceState = {
    status: 'idle',
    channelId: null,
    muted: true,
    deafened: false,
    input: '',
    output: '',
    inputMissing: false,
    outputMissing: false,
    error: '',
    participants: [],
  };
  private room?: Room;
  private lease?: Lease;
  private microphone?: LocalAudioTrack;
  private publishing = new WeakSet<LocalAudioTrack>();
  private elements = new Map<string, HTMLAudioElement>();
  private volumes = new Map<string, number>();
  private generation = 0;
  private captureAttempt = 0;
  private playback = new WeakMap<HTMLAudioElement, Promise<void>>();
  private wanted = false;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retryCount = 0;
  private beating = false;
  private disposed = false;
  onChange: () => void = () => {};
  constructor(private request: Request) {
    navigator.mediaDevices?.addEventListener('devicechange', this.devicesChanged);
  }
  update(values: Partial<VoiceState>) {
    this.state = { ...this.state, ...values };
    this.onChange();
  }
  async devices() {
    if (!navigator.mediaDevices)
      throw new Error('Audio requires a supported browser on localhost or HTTPS.');
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    probe.getTracks().forEach((track) => track.stop());
    return navigator.mediaDevices.enumerateDevices();
  }
  async selectInput(id: string) {
    const generation = this.generation;
    this.update({ input: id, inputMissing: false });
    if (this.state.status === 'connected') {
      try {
        await this.capture(this.generation);
      } catch (error) {
        if (this.wanted && generation === this.generation && this.state.input === id)
          this.update({ inputMissing: true, error: (error as Error).message });
      }
    }
  }
  async selectOutput(id: string) {
    for (const element of this.elements.values()) {
      element.muted = true;
      element.pause();
    }
    this.update({ output: id, outputMissing: false });
    for (const element of this.elements.values()) await this.play(element);
  }
  private async capture(generation: number) {
    const room = this.room,
      input = this.state.input,
      attempt = ++this.captureAttempt;
    const current = () =>
      this.wanted &&
      generation === this.generation &&
      this.room === room &&
      attempt === this.captureAttempt &&
      this.state.input === input &&
      !this.state.inputMissing;
    if (!room || !input || this.state.inputMissing) return;
    const { LocalAudioTrack, Track } = await import('livekit-client');
    if (!current()) return;
    const stream = await navigator.mediaDevices
      .getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: input },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .catch((error: unknown) => {
        if (current()) throw error;
        return undefined;
      });
    if (!stream) return;
    if (!current()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const media = stream.getAudioTracks()[0]!;
    // User-provided tracks prevent SDK device fallback/reacquisition.
    const track = new LocalAudioTrack(media, undefined, true);
    this.publishing.add(track);
    try {
      const previous = this.microphone;
      this.microphone = track;
      if (previous) {
        previous.stop();
        await room.localParticipant.unpublishTrack(previous);
      }
      if (!current()) {
        track.stop();
        return;
      }
      media.addEventListener(
        'ended',
        () => {
          if (this.microphone !== track) return;
          this.microphone = undefined;
          track.stop();
          void room.localParticipant.unpublishTrack(track).catch(() => {});
          this.update({
            inputMissing: true,
            error: 'Microphone disconnected. Choose a replacement; voice remains connected.',
          });
        },
        { once: true },
      );
      // Publish muted so preference changes cannot be lost before the SDK assigns a SID.
      await track.mute();
      if (!current()) {
        track.stop();
        return;
      }
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      if (!current()) {
        track.stop();
        await room.localParticipant.unpublishTrack(track);
        if (this.microphone === track) this.microphone = undefined;
      } else {
        this.publishing.delete(track);
        await this.applyMute();
      }
    } catch (error) {
      track.stop();
      if (this.microphone === track) this.microphone = undefined;
      if (current()) throw error;
    } finally {
      this.publishing.delete(track);
    }
  }
  async join(channelId: string) {
    if (this.wanted) throw new Error('Leave the current voice session first.');
    if (!this.state.input || !this.state.output)
      throw new Error('Select a microphone and speakers first.');
    this.wanted = true;
    const generation = ++this.generation;
    this.update({ status: 'joining', channelId, error: '', muted: true });
    this.retryCount = 0;
    try {
      const lease = await this.request<Lease>('/voice/join', 'POST', { channelId });
      if (!this.wanted || generation !== this.generation) {
        await this.request('/voice/leave', 'POST', { leaseId: lease.id });
        return;
      }
      this.lease = lease;
      this.heartbeat = setInterval(() => void this.pulse(), 10000);
      await this.connect(generation);
    } catch (error) {
      if (generation === this.generation) {
        await this.leave();
        this.update({ error: (error as Error).message });
      }
    }
  }
  private async pulse() {
    if (!this.lease || this.beating) return;
    this.beating = true;
    const generation = this.generation,
      previous = this.lease;
    try {
      await this.request('/voice/heartbeat', 'POST', { leaseId: previous.id });
    } catch (error) {
      if (!this.wanted || generation !== this.generation) return;
      const status = (error as { status?: number }).status;
      if (status === 410) {
        try {
          const next = await this.request<Lease>('/voice/join', 'POST', {
            channelId: previous.channelId,
            leaseId: previous.id,
          });
          if (!this.wanted || generation !== this.generation) {
            await this.request('/voice/leave', 'POST', { leaseId: next.id });
            return;
          }
          this.lease = next;
          const room = this.room;
          this.room = undefined;
          room?.removeAllListeners();
          this.clearMedia();
          await room?.disconnect();
          if (!this.wanted || generation !== this.generation || this.room) return;
          this.update({ status: 'reconnecting', error: '' });
          this.schedule(generation);
        } catch (renewal) {
          if (!this.wanted || generation !== this.generation) return;
          if ([401, 403, 409].includes((renewal as { status?: number }).status ?? 0)) {
            await this.leave();
            this.update({ error: 'Voice ended or is active on another device.' });
          } else this.update({ error: 'Voice service unavailable. Retrying…' });
        }
      } else if ([401, 403, 409].includes(status ?? 0)) {
        await this.leave();
        this.update({ error: 'Voice authorization ended. Join again after signing in.' });
      } else this.update({ error: 'Cannot reach the voice authorization service. Reconnecting…' });
    } finally {
      this.beating = false;
    }
  }
  private async connect(generation: number) {
    if (!this.wanted || generation !== this.generation || !this.lease || this.room) return;
    const { Room, RoomEvent } = await import('livekit-client');
    if (!this.wanted || generation !== this.generation || this.room) return;
    const room = new Room({
      singlePeerConnection: false,
      disconnectOnPageLeave: true,
      stopLocalTrackOnUnpublish: true,
    });
    this.room = room;
    const current = () => this.wanted && this.generation === generation && this.room === room;
    const participants = () => {
      if (current()) this.updateParticipants();
    };
    room
      .on(RoomEvent.ParticipantConnected, participants)
      .on(RoomEvent.ParticipantDisconnected, participants)
      .on(RoomEvent.LocalTrackPublished, participants)
      .on(RoomEvent.LocalTrackUnpublished, participants)
      .on(RoomEvent.TrackMuted, participants)
      .on(RoomEvent.TrackUnmuted, participants)
      .on(RoomEvent.ActiveSpeakersChanged, participants);
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (!current() || track.kind !== 'audio') return;
      const element = document.createElement('audio');
      element.autoplay = false;
      element.muted = true;
      element.srcObject = new MediaStream([track.mediaStreamTrack]);
      element.dataset.voiceAudio = participant.identity;
      this.elements.set(track.sid!, element);
      document.body.appendChild(element);
      void this.play(element, participant.identity);
      participants();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      const element = this.elements.get(track.sid!);
      if (element) {
        element.pause();
        element.remove();
        this.elements.delete(track.sid!);
      }
    });
    room.on(RoomEvent.Reconnecting, () => {
      if (current()) this.update({ status: 'reconnecting' });
    });
    room.on(RoomEvent.Reconnected, () => {
      if (current()) {
        this.update({ status: 'connected', error: '' });
        participants();
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (current()) {
        this.room = undefined;
        room.removeAllListeners();
        this.clearMedia();
        this.update({ status: 'reconnecting', participants: [] });
        this.schedule(generation);
      }
    });
    const url = new URL('/media', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      await room.connect(url.toString(), this.lease.credential, {
        autoSubscribe: true,
        maxRetries: 2,
        rtcConfig: {
          iceTransportPolicy: 'all',
          ...(this.lease.useServerIceServers ? {} : { iceServers: [] }),
        },
        peerConnectionTimeout: 10000,
      });
      if (!current()) {
        await room.disconnect();
        return;
      }
      this.retryCount = 0;
      this.update({ status: 'connected', error: '' });
      this.updateParticipants();
      if (!this.state.inputMissing)
        try {
          await this.capture(generation);
        } catch (error) {
          if (current()) this.update({ inputMissing: true, error: (error as Error).message });
        }
    } catch (error) {
      if (current()) {
        this.room = undefined;
        room.removeAllListeners();
        this.clearMedia();
        await room.disconnect();
        if (!this.wanted || generation !== this.generation || this.room) return;
        this.update({ status: 'reconnecting', error: (error as Error).message });
        this.schedule(generation);
      }
    }
  }
  private schedule(generation: number) {
    if (!this.wanted || generation !== this.generation) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () =>
        void (async () => {
          await this.pulse();
          if (this.wanted && generation === this.generation) {
            // Renewal may have scheduled another retry while this callback awaited pulse.
            clearTimeout(this.retry);
            this.retry = undefined;
            await this.connect(generation);
          }
        })(),
      Math.min(15000, 1000 * 2 ** this.retryCount++),
    );
  }
  private clearMedia() {
    this.captureAttempt++;
    this.microphone?.stop();
    this.microphone = undefined;
    for (const element of this.elements.values()) {
      element.pause();
      element.srcObject = null;
      element.remove();
    }
    this.elements.clear();
  }
  async leave() {
    this.wanted = false;
    this.generation++;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const room = this.room,
      lease = this.lease;
    this.room = undefined;
    this.lease = undefined;
    room?.removeAllListeners();
    this.clearMedia();
    this.update({ status: 'idle', channelId: null, participants: [] });
    await room?.disconnect();
    if (lease)
      try {
        await this.request('/voice/leave', 'POST', { leaseId: lease.id });
      } catch {
        this.update({
          error: 'Left locally. Server reservation expires within 45 seconds if offline.',
        });
      }
  }
  async mute() {
    this.update({ muted: !this.state.muted });
    await this.applyMute();
  }
  async deafen() {
    this.update({ deafened: !this.state.deafened });
    await this.applyMute();
    for (const element of this.elements.values()) await this.play(element);
  }
  private async applyMute() {
    if (this.microphone && this.publishing.has(this.microphone)) return;
    if (this.state.muted || this.state.deafened) await this.microphone?.mute();
    else if (!this.state.inputMissing) await this.microphone?.unmute();
  }
  async resumeAudio() {
    for (const element of this.elements.values()) await this.play(element);
  }
  volume(id: string, value: number) {
    this.volumes.set(id, value);
    for (const element of this.elements.values())
      if (element.dataset.voiceAudio === id) element.volume = value;
    this.updateParticipants();
  }
  private play(element: HTMLAudioElement, id = element.dataset.voiceAudio ?? '') {
    const generation = this.generation;
    const task = (this.playback.get(element) ?? Promise.resolve()).then(() =>
      this.playCurrent(element, id, generation),
    );
    this.playback.set(element, task);
    return task;
  }
  private async playCurrent(element: HTMLAudioElement, id: string, generation: number) {
    const current = () =>
      this.wanted &&
      generation === this.generation &&
      [...this.elements.values()].includes(element);
    if (!current()) return;
    element.volume = this.volumes.get(id) ?? 1;
    if (this.state.deafened || this.state.outputMissing || !this.state.output) {
      element.muted = true;
      element.pause();
      return;
    }
    try {
      if (typeof element.setSinkId !== 'function')
        throw new Error(
          'This browser cannot select an output device. Use Edge or the desktop app.',
        );
      const output = this.state.output;
      await element.setSinkId(output);
      if (!current() || output !== this.state.output) return;
      if (this.state.deafened || this.state.outputMissing || !this.wanted) {
        element.pause();
        return;
      }
      element.muted = false;
      await element.play();
    } catch (error) {
      element.muted = true;
      element.pause();
      if (current())
        this.update({ error: 'Audio output needs attention: ' + (error as Error).message });
    }
  }
  private updateParticipants() {
    const room = this.room;
    if (!room) return;
    const list = [room.localParticipant, ...room.remoteParticipants.values()];
    this.update({
      participants: list.map((p) => ({
        id: p.identity,
        name: p.name || p.identity,
        speaking: p.isSpeaking,
        muted: !p.isMicrophoneEnabled,
        volume: this.volumes.get(p.identity) ?? 1,
      })),
    });
  }
  private devicesChanged = async () => {
    if (this.disposed) return;
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      if (!this.disposed)
        this.update({ error: 'Cannot check audio devices. Try finding devices again.' });
      return;
    }
    if (this.disposed) return;
    if (
      this.state.input &&
      !devices.some((d) => d.kind === 'audioinput' && d.deviceId === this.state.input)
    ) {
      this.microphone?.stop();
      if (this.microphone)
        void this.room?.localParticipant.unpublishTrack(this.microphone).catch(() => {});
      this.microphone = undefined;
      this.update({
        inputMissing: true,
        error: 'Selected microphone is missing. Choose a replacement.',
      });
    }
    if (
      this.state.output &&
      !devices.some((d) => d.kind === 'audiooutput' && d.deviceId === this.state.output)
    ) {
      for (const element of this.elements.values()) {
        element.muted = true;
        element.pause();
      }
      this.update({
        outputMissing: true,
        error: 'Selected speakers are missing. Choose a replacement.',
      });
    }
  };
  dispose() {
    this.disposed = true;
    navigator.mediaDevices?.removeEventListener('devicechange', this.devicesChanged);
    this.onChange = () => {};
    void this.leave();
  }
}
