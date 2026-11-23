export function percentile(values, quantile) {
  return values.toSorted((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
}

export function renderedAudioTiming(visualTimes, observedAudioTimes, calibration, startTime) {
  const audioTimes = observedAudioTimes
    .map((time) => time - calibration.medianMs)
    .toSorted((a, b) => a - b);
  const matches = [];
  let audioIndex = 0;
  for (const visualTime of visualTimes) {
    // Each audio edge belongs to at most one frame transition.
    while (
      audioIndex + 1 < audioTimes.length &&
      Math.abs(audioTimes[audioIndex + 1] - visualTime) <
        Math.abs(audioTimes[audioIndex] - visualTime)
    ) {
      audioIndex++;
    }
    const offsetMs = audioTimes[audioIndex] - visualTime;
    if (Math.abs(offsetMs) < 350) {
      matches.push({ seconds: (visualTime - startTime) / 1000, offsetMs });
      audioIndex++;
    }
  }
  const steady = matches.filter(({ seconds }) => seconds >= 6).map(({ offsetMs }) => offsetMs);
  return {
    matched: matches.length,
    visualMarkers: visualTimes.length,
    steadyMarkers: steady.length,
    startupMarkerMs: matches[0]?.offsetMs,
    calibration,
    calibratedMedianMs: percentile(steady, 0.5),
    calibratedP95AbsoluteMs: percentile(steady.map(Math.abs), 0.95),
    driftMs:
      steady.length >= 24
        ? percentile(steady.slice(-12), 0.5) - percentile(steady.slice(0, 12), 0.5)
        : undefined,
  };
}
