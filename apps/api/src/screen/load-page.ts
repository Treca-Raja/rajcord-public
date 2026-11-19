// Serialized only into disposable stress-test profiles, never the application.
export function installScreenLoadSource(index: number, fileSource = false) {
  const peers: RTCPeerConnection[] = [],
    captures: MediaStreamTrack[] = [];
  let voicePeerCount: number | undefined;
  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      peers.push(this);
    }
  };
  let draws = 0;
  const starters = new Set<(at: number) => void>();
  navigator.mediaDevices.getDisplayMedia = async () => {
    if (fileSource) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { exact: 60 } },
        audio: false,
      });
      captures.push(...stream.getVideoTracks());
      return stream;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const context = canvas.getContext('2d', { alpha: false })!;
    let frame = 0;
    const paint = () => {
      context.fillStyle = '#17212b';
      context.fillRect(0, 0, 1920, 1080);
      for (let row = 0; row < 32; row++) {
        context.fillStyle = row % 2 ? '#d5e7c7' : '#86b7c7';
        context.fillRect(20, 100 + row * 28, 1100 + row * 19, 12);
      }
      context.fillStyle = '#ba7040';
      context.fillRect((frame++ * 12) % 1440, 120, 480, 800);
      context.fillStyle = 'white';
      context.font = '36px monospace';
      context.fillText('OWNED STRESS SOURCE ' + index + ' FRAME ' + frame, 20, 60);
      draws++;
    };
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const stream = canvas.captureStream(60),
      track = stream.getVideoTracks()[0]!;
    paint();
    // Refresh the picture while viewers join so each new sender can prime its decoder.
    let timer = setInterval(paint, 1000);
    const start = (at: number) => {
      if (startTimer !== undefined) return;
      startTimer = setTimeout(
        () => {
          clearInterval(timer);
          timer = setInterval(paint, 1000 / 60);
        },
        Math.max(0, at - Date.now()),
      );
    };
    starters.add(start);
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(timer);
      clearTimeout(startTimer);
      starters.delete(start);
      stop();
    };
    captures.push(track);
    return stream;
  };
  const rendered = new Map<HTMLVideoElement, { count: number; width: number; height: number }>();
  let traceStamps: number[] | null = null;
  const observe = () => {
    for (const video of document.querySelectorAll<HTMLVideoElement>('[data-screen-playback]')) {
      if (rendered.has(video)) continue;
      const state = { count: 0, width: 1920, height: 1080 };
      rendered.set(video, state);
      const frame: VideoFrameRequestCallback = (_, metadata) => {
        if (traceStamps && traceStamps.length < 2048 && metadata.rtpTimestamp !== undefined)
          traceStamps.push(metadata.rtpTimestamp >>> 0);
        state.count = metadata.presentedFrames;
        state.width = Math.min(state.width, metadata.width);
        state.height = Math.min(state.height, metadata.height);
        if (video.isConnected) video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    }
    for (const video of rendered.keys()) if (!video.isConnected) rendered.delete(video);
  };
  const observer = new MutationObserver(observe);
  observer.observe(document, { childList: true, subtree: true });
  Object.assign(window, {
    screenLoad: {
      // The room creates its LiveKit peers during voice setup, before the screen controls open.
      markVoicePeers() {
        voicePeerCount = peers.length;
      },
      traceFrames(active: boolean) {
        const result = traceStamps;
        traceStamps = active ? [] : null;
        return result;
      },
      start: (at: number) => {
        for (const start of starters) start(at);
      },
      async collect(owners: Record<string, number>, accounts: readonly string[]) {
        observe();
        const microphones = new Map<string, number>();
        for (const element of document.querySelectorAll<HTMLAudioElement>(
          'audio[data-voice-audio]',
        )) {
          const publisher = accounts.indexOf(element.dataset.voiceAudio ?? '');
          if (publisher < 0) continue;
          for (const track of (element.srcObject as MediaStream | null)?.getAudioTracks() ?? [])
            microphones.set(track.id, publisher);
        }
        const streams = [],
          outgoing = [];
        let voiceBytes = 0;
        const voice = [];
        for (const peer of peers.filter((item) => item.connectionState === 'connected')) {
          const report = await peer.getStats();
          const transport = [...report.values()].find(
            (row) => row.type === 'transport' && row.selectedCandidatePairId,
          );
          const pair = report.get(transport?.selectedCandidatePairId);
          const direct =
            !!pair &&
            [pair.localCandidateId, pair.remoteCandidateId].every((id) =>
              ['host', 'srflx', 'prflx'].includes(report.get(id)?.candidateType),
            );
          for (const row of report.values()) {
            if (row.type === 'inbound-rtp' && row.kind === 'audio') {
              voiceBytes += row.bytesReceived ?? 0;
              voice.push({
                publisher: microphones.get(row.trackIdentifier) ?? null,
                trackId: row.trackIdentifier,
                bytesReceived: row.bytesReceived,
                receivedSamples: row.totalSamplesReceived,
                concealedSamples: row.concealedSamples,
                concealmentEvents: row.concealmentEvents,
                interruptionCount: row.interruptionCount,
                totalInterruptionDuration: row.totalInterruptionDuration,
                packetsLost: row.packetsLost,
              });
            }
            if (row.type === 'outbound-rtp' && row.kind === 'video')
              outgoing.push({
                peer: peers.indexOf(peer),
                time: row.timestamp,
                frames: row.framesEncoded,
                framesSent: row.framesSent,
                totalEncodeTime: row.totalEncodeTime,
                packetsSent: row.packetsSent,
                totalPacketSendDelay: row.totalPacketSendDelay,
                roundTripTime: pair?.currentRoundTripTime,
                retransmittedBytes: row.retransmittedBytesSent,
                encodedFps: row.framesPerSecond,
                encoderImplementation: row.encoderImplementation,
                powerEfficientEncoder: row.powerEfficientEncoder,
                sourceFps: report.get(row.mediaSourceId)?.framesPerSecond,
                targetBitrate: row.targetBitrate,
                availableOutgoingBitrate: pair?.availableOutgoingBitrate,
                appliedMaxBitrate: peer
                  .getSenders()
                  .find((sender) => sender.track?.kind === 'video')
                  ?.getParameters().encodings[0]?.maxBitrate,
                bytes: row.bytesSent,
                limitation: row.qualityLimitationReason,
                codec: report.get(row.codecId)?.mimeType,
              });
            if (row.type !== 'inbound-rtp' || row.kind !== 'video') continue;
            const video = [...rendered.keys()].find((element) =>
              (element.srcObject as MediaStream | null)
                ?.getVideoTracks()
                .some((track) => track.id === row.trackIdentifier),
            );
            const share =
              video?.closest<HTMLElement>('[data-screen-share-id]')?.dataset.screenShareId;
            const publisher = share ? owners[share] : undefined;
            if (publisher === undefined || !video) continue;
            const frame = rendered.get(video)!;
            streams.push({
              publisher,
              viewer: index,
              time: row.timestamp,
              bytes: row.bytesReceived,
              decoded: row.framesDecoded,
              jitterBufferDelay: row.jitterBufferDelay,
              jitterBufferEmittedCount: row.jitterBufferEmittedCount,
              packetsLost: row.packetsLost,
              nackCount: row.nackCount,
              qpSum: row.qpSum,
              codec: report.get(row.codecId)?.mimeType,
              rendered: frame.count,
              direct,
              freezes: row.freezeCount ?? null,
              width: Math.min(row.frameWidth ?? 0, video.videoWidth, frame.width),
              height: Math.min(row.frameHeight ?? 0, video.videoHeight, frame.height),
            });
            frame.width = 1920;
            frame.height = 1080;
          }
        }
        return {
          sampledAt: performance.now(),
          streams,
          outgoing,
          voiceBytes,
          voice,
          draws,
          liveSources: captures.filter((track) => track.readyState === 'live').length,
          phase: document.querySelector<HTMLElement>('#screen-panel')?.dataset.phase,
          directoryShares: document.querySelectorAll('.screen-share-item').length,
          error: document.querySelector('.screen-error')?.textContent,
        };
      },
      stopped: () =>
        voicePeerCount !== undefined &&
        captures.every((track) => track.readyState === 'ended') &&
        peers.slice(voicePeerCount).every((peer) => peer.connectionState === 'closed'),
    },
  });
}
