import {
  SCREEN_RESOLUTIONS,
  SCREEN_FRAME_RATES,
  screenQualityCeiling,
  type ScreenResolution,
  type ScreenFrameRate,
} from '@tricord/shared';

export type WebCaptureDevices = Pick<MediaDevices, 'getDisplayMedia'>;
export type CaptureSound = 'none' | 'tab' | 'system';
export type CaptureEnd =
  'stopped' | 'cancelled' | 'disposed' | 'video-ended' | 'audio-ended' | 'stream-changed';
export type CaptureErrorCode =
  | 'invalid'
  | 'unsupported'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'denied'
  | 'failed'
  | 'invalid_tracks'
  | 'missing_sound'
  | 'source_ended'
  | 'disposed';
export class ScreenCaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export type LocalScreenCapture = Readonly<{
  stream: MediaStream;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  displaySurface: 'browser' | 'window' | 'monitor';
  // Private local preview metadata; never put this result into a signaling DTO.
  localLabel: string;
  sound: CaptureSound;
  ended: Promise<CaptureEnd>;
  dispose: () => void;
}>;
type DisplayOptions = DisplayMediaStreamOptions & {
  systemAudio: 'exclude' | 'include';
  windowAudio: 'exclude';
  selfBrowserSurface: 'exclude';
  surfaceSwitching: 'exclude';
};
type Attempt = { cancel: (reason: CaptureEnd) => void };

export class WebScreenCapture {
  private current?: Attempt;
  private pickerPending = false;
  private disposed = false;
  private readonly timeoutMs: number;
  // Runtime qualification policy is separate from the user's per-capture sound consent.
  private readonly tabAudio: 'unqualified' | 'qualified-selected-tab' | 'consented-selected-tab';
  private readonly desktop: boolean;
  constructor(
    private readonly devices: WebCaptureDevices | undefined,
    options: {
      timeoutMs?: number;
      tabAudio?: 'unqualified' | 'qualified-selected-tab' | 'consented-selected-tab';
      desktop?: boolean;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.tabAudio = options.tabAudio ?? 'unqualified';
    this.desktop = options.desktop === true;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2147483647 ||
      !['unqualified', 'qualified-selected-tab', 'consented-selected-tab'].includes(this.tabAudio)
    )
      throw new ScreenCaptureError('invalid', 'Invalid screen capture policy.');
  }
  start(request: {
    sound: CaptureSound;
    signal?: AbortSignal;
    resolution?: ScreenResolution;
    frameRate?: ScreenFrameRate;
  }): Promise<LocalScreenCapture> {
    if (this.disposed)
      return Promise.reject(new ScreenCaptureError('disposed', 'Screen capture was disposed.'));
    if (!request || !(this.desktop ? ['none', 'system'] : ['none', 'tab']).includes(request.sound))
      return Promise.reject(
        new ScreenCaptureError('invalid', 'Choose source sound or video only explicitly.'),
      );
    const { sound, signal } = request;
    const explicit = request.resolution !== undefined || request.frameRate !== undefined;
    if (
      explicit &&
      (!(SCREEN_RESOLUTIONS as readonly unknown[]).includes(request.resolution) ||
        !(SCREEN_FRAME_RATES as readonly unknown[]).includes(request.frameRate))
    )
      return Promise.reject(
        new ScreenCaptureError('invalid', 'Choose a supported resolution and frame rate.'),
      );
    if (signal?.aborted)
      return Promise.reject(new ScreenCaptureError('cancelled', 'Screen capture was cancelled.'));
    if (this.current || this.pickerPending)
      return Promise.reject(
        new ScreenCaptureError(
          'busy',
          'Finish the current source selection or stop the current capture first.',
        ),
      );
    if (typeof this.devices?.getDisplayMedia !== 'function')
      return Promise.reject(
        new ScreenCaptureError('unsupported', 'Display capture is unavailable.'),
      );
    if (sound === 'tab' && this.tabAudio === 'unqualified')
      return Promise.reject(
        new ScreenCaptureError(
          'unsupported',
          'Selected-tab sound is not qualified for this runtime.',
        ),
      );

    let resolve!: (capture: LocalScreenCapture) => void,
      reject!: (error: ScreenCaptureError) => void;
    const result = new Promise<LocalScreenCapture>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let finish!: (reason: CaptureEnd) => void;
    const ended = new Promise<CaptureEnd>((yes) => {
      finish = yes;
    });
    let terminal = false,
      handedOff = false;
    let stream: MediaStream | undefined;
    const owned = new Set<MediaStreamTrack>();
    const stopped = new WeakSet<MediaStreamTrack>();
    const listeners: (() => void)[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const remove of listeners.splice(0)) remove();
      if (stream) for (const track of stream.getTracks()) owned.add(track);
      for (const track of owned)
        if (!stopped.has(track)) {
          stopped.add(track);
          track.stop();
        }
      owned.clear();
      if (this.current === attempt) this.current = undefined;
    };
    const fail = (error: ScreenCaptureError) => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(error);
    };
    const cancel = (reason: CaptureEnd) => {
      if (terminal) return;
      terminal = true;
      cleanup();
      if (handedOff) finish(reason);
      else reject(new ScreenCaptureError('cancelled', 'Screen capture was cancelled.'));
    };
    const abort = () => cancel('cancelled');
    const attempt: Attempt = { cancel };
    this.current = attempt;
    const timer = setTimeout(
      () => fail(new ScreenCaptureError('timeout', 'Source selection timed out.')),
      this.timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    const options: DisplayOptions = {
      video: (() => {
        const ceiling = screenQualityCeiling({
          profile: 'smooth',
          videoBitrate: null,
          ...(explicit ? { resolution: request.resolution, frameRate: request.frameRate } : {}),
        });
        return {
          width: { ideal: ceiling.width },
          height: { ideal: ceiling.height },
          frameRate: { ideal: ceiling.frameRate, max: ceiling.frameRate },
        };
      })(),
      audio: sound !== 'none',
      systemAudio: sound === 'system' ? 'include' : 'exclude',
      windowAudio: 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    };
    this.pickerPending = true;
    let picker: Promise<MediaStream>;
    try {
      // Invoke synchronously on the caller's gesture stack; no pre-picker await or device probe.
      picker = this.devices.getDisplayMedia(options);
    } catch (cause) {
      this.pickerPending = false;
      fail(this.captureError(cause));
      return result;
    }
    void picker.then(
      (received) => {
        this.pickerPending = false;
        stream = received;
        if (terminal || this.current !== attempt) {
          cleanup();
          return;
        }
        try {
          const tracks = stream.getTracks();
          for (const track of tracks) owned.add(track);
          const videos = tracks.filter((track) => track.kind === 'video');
          const audios = tracks.filter((track) => track.kind === 'audio');
          if (
            videos.length !== 1 ||
            audios.length > 1 ||
            tracks.length !== videos.length + audios.length ||
            owned.size !== tracks.length ||
            tracks.some((track) => track.readyState !== 'live' || !track.enabled)
          )
            throw new ScreenCaptureError(
              'invalid_tracks',
              'The selected source did not provide the required live tracks.',
            );
          const video = videos[0]!,
            audio = audios[0] ?? null;
          const displaySurface = video.getSettings().displaySurface;
          if (
            displaySurface !== 'browser' &&
            displaySurface !== 'window' &&
            displaySurface !== 'monitor'
          )
            throw new ScreenCaptureError(
              'unsupported',
              'The selected display source cannot be verified.',
            );
          if (sound === 'none' && audio)
            throw new ScreenCaptureError(
              'invalid_tracks',
              'Unexpected source sound was returned for video-only capture.',
            );
          if (sound !== 'none' && !audio)
            throw new ScreenCaptureError(
              'missing_sound',
              'No source sound was provided. Choose another source or explicitly share video only.',
            );
          if (sound === 'tab' && displaySurface !== 'browser')
            throw new ScreenCaptureError(
              'unsupported',
              'Tab sound requires a supported browser-tab source.',
            );
          if (sound === 'system' && displaySurface !== 'monitor')
            throw new ScreenCaptureError(
              'unsupported',
              'System sound requires a selected display.',
            );
          const listen = (target: EventTarget, event: string, handler: () => void) => {
            target.addEventListener(event, handler);
            listeners.push(() => target.removeEventListener(event, handler));
          };
          listen(video, 'ended', () => cancel('video-ended'));
          if (audio) listen(audio, 'ended', () => cancel('audio-ended'));
          listen(stream, 'addtrack', () => cancel('stream-changed'));
          listen(stream, 'removetrack', () => cancel('stream-changed'));
          if (tracks.some((track) => track.readyState !== 'live'))
            throw new ScreenCaptureError(
              'source_ended',
              'The selected source ended before capture was ready.',
            );
          if (terminal || this.current !== attempt) {
            cleanup();
            return;
          }
          clearTimeout(timer);
          handedOff = true;
          resolve(
            Object.freeze({
              stream,
              video,
              audio,
              displaySurface,
              localLabel: video.label,
              sound,
              ended,
              dispose: () => cancel('stopped'),
            }),
          );
        } catch (cause) {
          fail(cause instanceof ScreenCaptureError ? cause : this.captureError(cause));
        }
      },
      (cause) => {
        this.pickerPending = false;
        fail(this.captureError(cause));
      },
    );
    return result;
  }
  stop() {
    this.current?.cancel('stopped');
  }
  dispose() {
    this.disposed = true;
    this.current?.cancel('disposed');
  }
  private captureError(cause: unknown) {
    const name = cause instanceof Error ? cause.name : '';
    const code =
      name === 'NotAllowedError' ? 'denied' : name === 'AbortError' ? 'cancelled' : 'failed';
    return new ScreenCaptureError(
      code,
      'The browser could not capture the selected display source.',
      { cause },
    );
  }
}
