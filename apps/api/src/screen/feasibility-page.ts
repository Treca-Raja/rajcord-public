// Serialized into the loopback-only fixture. Keep this function self-contained.
export function installFixture() {
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
  const draw = (now: number) => {
    // Deterministic moving tiles provide changing content, not a static 60-fps claim.
    const frame = Math.floor(((now - sourceStart) * 60) / 1000);
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
    context.fillStyle = '#000';
    context.fillRect(0, 0, 650, 80);
    context.fillStyle = '#fff';
    context.font = '36px monospace';
    context.fillText(`SYNTHETIC ${frame} ${Math.round(now)}ms`, 12, 54);
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
      audioRms: (() => {
        if (!analyser) return null;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      })(),
    };
  };
  const api = {
    startSource(kind = 'motion') {
      content = kind;
      video.style.display = 'none';
      sourceStart = performance.now();
      animation = requestAnimationFrame(draw);
    },
    startTonePlayback: () => tone(true).then(() => true),
    async capture(mode: 'canvas' | 'display', kind = 'motion') {
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
    async create(sender: boolean, codec: string) {
      peer = new RTCPeerConnection({ iceServers: [] });
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
              track.kind === 'video' ? [{ maxBitrate: 8000000, maxFramerate: 60 }] : undefined,
          });
          if (track.kind === 'video') {
            const codecs = RTCRtpSender.getCapabilities('video')?.codecs.filter(
              (c) => c.mimeType.toLowerCase() === 'video/' + codec.toLowerCase(),
            );
            if (!codecs?.length) throw new Error('Requested codec unavailable');
            transceiver.setCodecPreferences(codecs);
          }
        }
      } else {
        peer.ontrack = (e) => {
          video.srcObject = e.streams[0]!;
        };
        const renderedFrame = () => {
          rendered++;
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
    async cap(bits: number) {
      const sender = peer!.getSenders().find((s) => s.track?.kind === 'video')!;
      const parameters = sender.getParameters();
      parameters.encodings[0]!.maxBitrate = bits;
      parameters.encodings[0]!.maxFramerate = 60;
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
      return sender.getParameters().encodings[0]!.maxBitrate;
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
  return `<!doctype html><html><head><title>Rajcord synthetic screen fixture</title><style>html,body{margin:0;background:#000;overflow:hidden}canvas{width:100vw;height:100vh}video{position:fixed;width:100vw;height:100vh;inset:0;object-fit:contain}video:not([src]){pointer-events:none}</style></head><body><canvas width="1920" height="1080"></canvas><video muted playsinline></video><script>(${installFixture.toString()})()</script></body></html>`;
}
