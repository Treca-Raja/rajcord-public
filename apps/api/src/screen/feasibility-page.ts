import { screenImageQuality } from './feasibility-quality.js';

// Serialized into the loopback-only fixture. Keep this function self-contained.
export function installFixture(measureQuality: typeof screenImageQuality) {
  const canvas = document.querySelector('canvas')!;
  const context = canvas.getContext('2d', { alpha: false })!;
  const video = document.querySelector('video')!;
  let animation = 0,
    draws = 0,
    rendered = 0;
  let audio: AudioContext | undefined, oscillator: OscillatorNode | undefined;
  let capture: MediaStream | undefined, peer: RTCPeerConnection | undefined;
  let sourceStart = performance.now();
  let renderCallback = 0;
  let analyser: AnalyserNode | undefined;
  let content = 'motion';
  const candidates: RTCIceCandidateInit[] = [];
  let completed = false;
  const iceErrors: number[] = [];
  const paint = (
    context: CanvasRenderingContext2D,
    frame: number,
    now: number,
    content: string,
  ) => {
    for (let y = 0; y < 1080; y += 60)
      for (let x = 0; x < 1920; x += 60) {
        const n = (x * 13 + y * 7 + (content === 'stress' ? frame * 17 : 0)) % 255;
        context.fillStyle = `rgb(${n},${(n * 3) % 255},${(n * 7) % 255})`;
        context.fillRect(x, y, 60, 60);
      }
    if (content === 'motion') {
      const left = (frame * 8) % 1440;
      const top = 200 + Math.round(Math.sin(frame / 60) * 140);
      context.fillStyle = '#122c31';
      context.fillRect(left, top, 480, 360);
      for (let row = 0; row < 8; row++) {
        context.fillStyle = row % 2 ? '#c4e99c' : '#86b7c7';
        context.fillRect(left + 20, top + 20 + row * 40, 200 + row * 28, 20);
      }
    }
    if (content === 'text' || content === 'static') {
      context.fillStyle = '#17212b';
      context.fillRect(0, 80, 1920, 1000);
      context.fillStyle = '#edf2f7';
      context.font = '18px monospace';
      for (let row = 0; row < 38; row++)
        context.fillText(
          `const sample_${row} = { detail: 'AaBb0123456789', value: ${row} };`,
          30,
          110 + row * 25,
        );
    }
    context.fillStyle = '#000';
    context.fillRect(0, 0, 650, 80);
    context.fillStyle = '#fff';
    context.font = '36px monospace';
    context.fillText(`SYNTHETIC ${frame} ${Math.round(now)}ms`, 12, 54);
    const check = (frame & 255) ^ ((frame >> 8) & 255);
    for (let bit = 0; bit < 28; bit++) {
      const white =
        bit === 0 ||
        bit === 27 ||
        (bit >= 2 && bit < 18 && ((frame >> (bit - 2)) & 1) === 1) ||
        (bit >= 18 && bit < 26 && ((check >> (bit - 18)) & 1) === 1);
      context.fillStyle = white ? '#fff' : '#000';
      context.fillRect(bit * 30, 1040, 30, 40);
    }
  };
  const draw = (now: number) => {
    const frame = content === 'static' ? 0 : Math.floor(((now - sourceStart) * 60) / 1000);
    paint(context, frame, now, content);
    draws++;
    animation = requestAnimationFrame(draw);
  };
  const tone = async (playback: boolean) => {
    audio = new AudioContext();
    oscillator = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.08;
    oscillator.frequency.value = 440;
    oscillator.connect(gain);
    const destination = audio.createMediaStreamDestination();
    gain.connect(destination);
    if (playback) gain.connect(audio.destination);
    oscillator.start();
    await audio.resume();
    return destination.stream.getAudioTracks()[0]!;
  };
  const snapshot = async () => {
    if (!peer) throw new Error('No peer');
    const report = await peer.getStats();
    // Explicit allowlist: never export SDP, candidates, addresses or device labels.
    const records = [...report.values()] as (RTCStats & Record<string, unknown>)[];
    const rtp = records
      .filter((s) => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(s.type))
      .map((s) => {
        const fields = [
          'type',
          'kind',
          'timestamp',
          'bytesSent',
          'bytesReceived',
          'packetsReceived',
          'packetsLost',
          'retransmittedPacketsSent',
          'retransmittedBytesSent',
          'nackCount',
          'pliCount',
          'freezeCount',
          'totalFreezesDuration',
          'jitter',
          'jitterBufferDelay',
          'jitterBufferEmittedCount',
          'framesEncoded',
          'framesDecoded',
          'framesRendered',
          'framesDropped',
          'frameWidth',
          'frameHeight',
          'framesPerSecond',
          'totalEncodeTime',
          'totalDecodeTime',
          'totalAudioEnergy',
          'totalSamplesDuration',
          'qualityLimitationReason',
          'encoderImplementation',
          'decoderImplementation',
          'powerEfficientEncoder',
          'width',
          'height',
          'frames',
        ];
        return Object.fromEntries(fields.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
      });
    const transport = records.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = records.find((s) => s.id === transport?.selectedCandidatePairId);
    const local = records.find((s) => s.id === pair?.localCandidateId);
    const remote = records.find((s) => s.id === pair?.remoteCandidateId);
    const codecs = records
      .filter((s) => s.type === 'codec')
      .map((s) => ({ mimeType: s.mimeType, clockRate: s.clockRate }));
    return {
      time: performance.now(),
      rtp,
      codecs,
      route: pair
        ? {
            state: pair.state,
            localType: local?.candidateType,
            remoteType: remote?.candidateType,
            protocol: local?.protocol,
          }
        : null,
      rendered,
      draws,
      sourceElapsedMs: performance.now() - sourceStart,
      video: {
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        muted: video.muted,
      },
      tracks:
        capture?.getTracks().map((t) => ({
          kind: t.kind,
          readyState: t.readyState,
          settings: {
            width: t.getSettings().width,
            height: t.getSettings().height,
            frameRate: t.getSettings().frameRate,
            displaySurface: t.getSettings().displaySurface,
          },
        })) ?? [],
      connection: peer.connectionState,
      iceErrors: [...iceErrors],
      audioRms: (() => {
        if (!analyser) return null;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      })(),
    };
  };
  const qualitySurface = document.createElement('canvas');
  qualitySurface.width = 1920;
  qualitySurface.height = 1080;
  const qualityContext = qualitySurface.getContext('2d', { willReadFrequently: true })!;
  const referenceSurface = document.createElement('canvas');
  referenceSurface.width = 1920;
  referenceSurface.height = 1080;
  const referenceContext = referenceSurface.getContext('2d', { willReadFrequently: true })!;
  const api = {
    freezeSource() {
      cancelAnimationFrame(animation);
      animation = 0;
    },
    quality(kind: string) {
      if (video.readyState < 2 || !video.videoWidth) return { status: 'not-ready' };
      qualityContext.drawImage(video, 0, 0, 1920, 1080);
      const marker = (bit: number) => {
        const data = qualityContext.getImageData(bit * 30 + 12, 1055, 6, 6).data;
        let total = 0;
        for (let offset = 0; offset < data.length; offset += 4)
          total += (data[offset]! + data[offset + 1]! + data[offset + 2]!) / 3;
        return total / 36;
      };
      if (marker(0) < 160 || marker(1) > 90 || marker(26) > 90 || marker(27) < 160)
        return { status: 'unaligned' };
      let frame = 0;
      for (let bit = 0; bit < 16; bit++) if (marker(bit + 2) >= 128) frame |= 1 << bit;
      let check = 0;
      for (let bit = 0; bit < 8; bit++) if (marker(bit + 18) >= 128) check |= 1 << bit;
      if (check !== ((frame & 255) ^ (frame >> 8))) return { status: 'unaligned' };
      paint(referenceContext, frame, 0, kind);
      const reference = referenceContext.getImageData(0, 80, 1920, 960).data;
      const decoded = qualityContext.getImageData(0, 80, 1920, 960).data;
      return {
        status: 'available',
        frame,
        width: video.videoWidth,
        height: video.videoHeight,
        ...measureQuality(reference, decoded, 1920, 960),
      };
    },
    startSource(kind = 'motion') {
      content = kind;
      video.style.display = 'none';
      sourceStart = performance.now();
      animation = requestAnimationFrame(draw);
    },
    startTonePlayback: () => tone(true).then(() => true),
    async capture(mode: 'canvas' | 'display', kind = 'motion') {
      content = kind;
      if (mode === 'display')
        capture = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
          audio: true,
        });
      else {
        api.startSource(kind);
        capture = canvas.captureStream(60);
        capture.addTrack(await tone(false));
      }
      return capture.getTracks().map((t) => t.kind);
    },
    async create(
      sender: boolean,
      codec: string,
      hint = 'auto',
      configuration?: RTCConfiguration | null,
      initialBitrate = 8000000,
    ) {
      peer = new RTCPeerConnection(configuration ?? { iceServers: [] });
      peer.addEventListener('icecandidateerror', (event) =>
        iceErrors.push((event as RTCPeerConnectionIceErrorEvent).errorCode),
      );
      peer.onicecandidate = (e) => {
        if (e.candidate) candidates.push(e.candidate.toJSON());
        else completed = true;
      };
      if (sender) {
        if (!capture) throw new Error('Capture missing');
        for (const track of capture.getTracks()) {
          const transceiver = peer.addTransceiver(track, {
            direction: 'sendonly',
            streams: [capture],
            sendEncodings:
              track.kind === 'video'
                ? [{ maxBitrate: initialBitrate, maxFramerate: 60 }]
                : undefined,
          });
          if (track.kind === 'video') {
            track.contentHint =
              hint === 'auto' || hint === 'fixed'
                ? ['text', 'static'].includes(content)
                  ? 'detail'
                  : 'motion'
                : hint;
            const available = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
            const codecs = available.filter(
              (c) => c.mimeType.toLowerCase() === 'video/' + codec.toLowerCase(),
            );
            if (!codecs?.length) throw new Error('Requested codec unavailable');
            transceiver.setCodecPreferences([
              ...codecs,
              ...available.filter((item) => /^video\/(rtx|red|ulpfec)$/i.test(item.mimeType)),
            ]);
            if (hint === 'fixed') {
              const parameters = transceiver.sender.getParameters();
              parameters.degradationPreference =
                'maintain-framerate-and-resolution' as RTCDegradationPreference;
              await transceiver.sender.setParameters(parameters);
            }
          }
        }
      } else {
        peer.ontrack = (e) => {
          video.srcObject = e.streams[0]!;
        };
        const renderedFrame: VideoFrameRequestCallback = (_, metadata) => {
          rendered = metadata.presentedFrames;
          renderCallback = video.requestVideoFrameCallback(renderedFrame);
        };
        renderCallback = video.requestVideoFrameCallback(renderedFrame);
      }
    },
    async offer() {
      await peer!.setLocalDescription(await peer!.createOffer());
      return peer!.localDescription!.toJSON();
    },
    async answer(offer: RTCSessionDescriptionInit) {
      await peer!.setRemoteDescription(offer);
      await peer!.setLocalDescription(await peer!.createAnswer());
      return peer!.localDescription!.toJSON();
    },
    async accept(answer: RTCSessionDescriptionInit) {
      await peer!.setRemoteDescription(answer);
    },
    ice() {
      return { candidates: candidates.splice(0), completed };
    },
    async addIce(items: RTCIceCandidateInit[]) {
      for (const item of items) await peer!.addIceCandidate(item);
    },
    async cap(bits: number, hint = 'auto', kind = content) {
      const sender = peer!.getSenders().find((s) => s.track?.kind === 'video')!;
      const parameters = sender.getParameters();
      parameters.encodings[0]!.maxBitrate = bits;
      parameters.encodings[0]!.maxFramerate = 60;
      parameters.degradationPreference =
        hint === 'fixed'
          ? ('maintain-framerate-and-resolution' as RTCDegradationPreference)
          : (hint === 'auto' ? (['text', 'static'].includes(kind) ? 'detail' : 'motion') : hint) ===
              'detail'
            ? 'maintain-resolution'
            : 'maintain-framerate';
      await sender.setParameters(parameters);
      const observed = sender.getParameters();
      if (
        hint === 'fixed' &&
        (observed.degradationPreference !== parameters.degradationPreference ||
          observed.encodings[0]?.maxFramerate !== 60)
      )
        throw new Error('Fixed video format was not confirmed by the sender.');
      return observed.encodings[0]!.maxBitrate;
    },
    sourceStats() {
      return { time: performance.now(), draws };
    },
    async play() {
      // Decode/inspect sound through a zero-gain graph; never play test audio on speakers.
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      const output = audio.createGain();
      output.gain.value = 0;
      audio.createMediaStreamSource(video.srcObject as MediaStream).connect(analyser);
      analyser.connect(output);
      output.connect(audio.destination);
      video.muted = true;
      await audio.resume();
      await video.play();
    },
    snapshot,
    async stop() {
      cancelAnimationFrame(animation);
      video.cancelVideoFrameCallback(renderCallback);
      capture?.getTracks().forEach((t) => t.stop());
      peer?.close();
      video.pause();
      video.srcObject = null;
      oscillator?.stop();
      await audio?.close();
      return {
        tracksEnded: capture?.getTracks().every((t) => t.readyState === 'ended') ?? true,
        peerClosed: !peer || peer.connectionState === 'closed',
        detached: video.srcObject === null,
      };
    },
  };
  // This fixture must never acquire a physical microphone or camera.
  navigator.mediaDevices.getUserMedia = async () => {
    throw new Error('Physical capture is forbidden in screen feasibility tests.');
  };
  Object.assign(window, { screenFixture: api });
}

export function fixtureHtml() {
  return `<!doctype html><html><head><title>Rajcord synthetic screen fixture</title><style>html,body{margin:0;background:#000;overflow:hidden}canvas{width:100vw;height:100vh}video{position:fixed;width:100vw;height:100vh;inset:0;object-fit:contain}video:not([src]){pointer-events:none}</style></head><body><canvas width="1920" height="1080"></canvas><video muted playsinline></video><script>(${installFixture.toString()})(${screenImageQuality.toString()})</script></body></html>`;
}
