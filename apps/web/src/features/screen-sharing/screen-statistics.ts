export type ScreenMediaSample = Readonly<{
  timestamp: number;
  direction: 'outbound' | 'inbound';
  bitrate: number | null;
  fps: number | null;
  sourceFps: number | null;
  renderedFps: number | null;
  receiverDroppedFrames: number | null;
  width: number | null;
  height: number | null;
  loss: number | null;
  roundTripTime: number | null;
  workMsPerFrame: number | null;
  meanPacketSendDelayMs: number | null;
  meanJitterBufferDelayMs: number | null;
  freezes: number | null;
  limitation: 'none' | 'cpu' | 'bandwidth' | 'other' | null;
  route: 'direct' | 'relay' | null;
  codec: string | null;
  targetBitrate?: number | null;
  retransmitBitrate?: number | null;
  qpMean?: number | null;
  powerEfficientEncoder?: boolean | null;
}>;

type Row = RTCStats & Record<string, unknown>;
const number = (row: Row | undefined, key: string): number | null => {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};
const difference = (before: Row | undefined, after: Row, key: string) => {
  const a = number(before, key),
    b = number(after, key);
  return a !== null && b !== null && b >= a ? b - a : null;
};

// Retain only numeric counters. Candidate addresses, SDP and source/device identifiers never leave here.
export class ScreenStatistics {
  private previous = new Map<string, Row>();
  sample(
    report: RTCStatsReport,
    direction: ScreenMediaSample['direction'],
  ): ScreenMediaSample | null {
    const rows = [...report.values()] as Row[];
    const video = rows.find(
      (row) => row.type === direction + '-rtp' && row.kind === 'video' && !row.isRemote,
    );
    if (!video) return null;
    const before = this.previous.get(video.id);
    const seconds = before ? (video.timestamp - before.timestamp) / 1000 : 0;
    const interval = seconds > 0 && seconds <= 15;
    const bytes = difference(
      before,
      video,
      direction === 'outbound' ? 'bytesSent' : 'bytesReceived',
    );
    const frames = difference(
      before,
      video,
      direction === 'outbound' ? 'framesEncoded' : 'framesDecoded',
    );
    const retransmitted = difference(before, video, 'retransmittedBytesSent');
    const source =
      direction === 'outbound'
        ? (report.get(video.mediaSourceId as string) as Row | undefined)
        : undefined;
    const rendered = direction === 'inbound' ? difference(before, video, 'framesRendered') : null;
    const qp = difference(before, video, 'qpSum');
    const work = difference(
      before,
      video,
      direction === 'outbound' ? 'totalEncodeTime' : 'totalDecodeTime',
    );
    const remote = rows.find(
      (row) => row.type === 'remote-inbound-rtp' && row.localId === video.id,
    );
    const lossRow = direction === 'outbound' ? remote : video;
    const oldLoss = lossRow ? this.previous.get(lossRow.id) : undefined;
    const lost = lossRow ? difference(oldLoss, lossRow, 'packetsLost') : null;
    const received = lossRow ? difference(oldLoss, lossRow, 'packetsReceived') : null;
    const sent = difference(before, video, 'packetsSent');
    const sendDelay = difference(before, video, 'totalPacketSendDelay');
    const bufferDelay = difference(before, video, 'jitterBufferDelay');
    const emitted = difference(before, video, 'jitterBufferEmittedCount');
    const fraction = number(remote, 'fractionLost');
    const freshRemote = remote && oldLoss && remote.timestamp > oldLoss.timestamp;
    const transport = rows.find(
      (row) => row.type === 'transport' && typeof row.selectedCandidatePairId === 'string',
    );
    const pair = transport
      ? (report.get(transport.selectedCandidatePairId as string) as Row | undefined)
      : undefined;
    const local = pair
      ? (report.get(pair.localCandidateId as string) as Row | undefined)
      : undefined;
    const distant = pair
      ? (report.get(pair.remoteCandidateId as string) as Row | undefined)
      : undefined;
    const codec = report.get(video.codecId as string) as Row | undefined;
    const limitation = video.qualityLimitationReason;
    this.previous.clear();
    for (const row of [video, lossRow]) {
      if (!row) continue;
      const counters: Row = { id: row.id, timestamp: row.timestamp, type: row.type };
      for (const key of [
        'bytesSent',
        'bytesReceived',
        'retransmittedBytesSent',
        'qpSum',
        'packetsSent',
        'totalPacketSendDelay',
        'jitterBufferDelay',
        'jitterBufferEmittedCount',
        'framesEncoded',
        'framesDecoded',
        'framesRendered',
        'framesDropped',
        'totalEncodeTime',
        'totalDecodeTime',
        'packetsLost',
        'packetsReceived',
        'freezeCount',
      ]) {
        if (number(row, key) !== null) counters[key] = row[key];
      }
      this.previous.set(row.id, counters);
    }
    return Object.freeze({
      timestamp: video.timestamp,
      targetBitrate: number(video, 'targetBitrate'),
      retransmitBitrate: interval && retransmitted !== null ? (retransmitted * 8) / seconds : null,
      qpMean: interval && frames && qp !== null ? qp / frames : null,
      powerEfficientEncoder:
        typeof video.powerEfficientEncoder === 'boolean' ? video.powerEfficientEncoder : null,
      direction,
      bitrate: interval && bytes !== null ? (bytes * 8) / seconds : null,
      fps: interval && frames !== null ? frames / seconds : null,
      sourceFps:
        source?.type === 'media-source' && source.kind === 'video'
          ? number(source, 'framesPerSecond')
          : null,
      renderedFps: interval && rendered !== null ? rendered / seconds : null,
      receiverDroppedFrames:
        interval && direction === 'inbound' ? difference(before, video, 'framesDropped') : null,
      width: number(video, 'frameWidth'),
      height: number(video, 'frameHeight'),
      loss:
        interval && lost !== null && received !== null && lost + received > 0
          ? lost / (lost + received)
          : interval && freshRemote && fraction !== null && fraction <= 1
            ? fraction
            : interval && freshRemote && lost !== null && sent !== null && sent > 0
              ? Math.min(1, lost / sent)
              : null,
      roundTripTime: number(remote, 'roundTripTime') ?? number(pair, 'currentRoundTripTime'),
      workMsPerFrame: interval && frames && work !== null ? (work * 1000) / frames : null,
      meanPacketSendDelayMs:
        direction === 'outbound' && interval && sent && sendDelay !== null
          ? (sendDelay * 1000) / sent
          : null,
      meanJitterBufferDelayMs:
        direction === 'inbound' && interval && emitted && bufferDelay !== null
          ? (bufferDelay * 1000) / emitted
          : null,
      freezes: interval ? difference(before, video, 'freezeCount') : null,
      limitation: ['none', 'cpu', 'bandwidth', 'other'].includes(limitation as string)
        ? (limitation as ScreenMediaSample['limitation'])
        : null,
      route:
        local?.candidateType === 'relay' || distant?.candidateType === 'relay'
          ? 'relay'
          : local && distant
            ? 'direct'
            : null,
      codec:
        typeof codec?.mimeType === 'string' && /^video\/[a-z0-9.-]+$/i.test(codec.mimeType)
          ? codec.mimeType
          : null,
    });
  }
}
