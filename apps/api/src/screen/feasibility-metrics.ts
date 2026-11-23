import { SCREEN_VIDEO_BITRATES } from '@tricord/shared';

const feasibilityBitrates: readonly number[] = [...SCREEN_VIDEO_BITRATES, 17000000];

export type Counters = {
  time: number;
  bytes: number;
  frames?: number;
  width?: number;
  height?: number;
  workSeconds?: number;
};

export function delta(before: Counters, after: Counters) {
  const seconds = (after.time - before.time) / 1000;
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(before.bytes) ||
    !Number.isFinite(after.bytes) ||
    seconds <= 0 ||
    after.bytes < before.bytes
  )
    throw new Error('Invalid or reset media measurement interval.');
  const frames =
    before.frames !== undefined && after.frames !== undefined
      ? after.frames - before.frames
      : undefined;
  if (frames !== undefined && (!Number.isFinite(frames) || frames < 0))
    throw new Error('Frame counter reset or invalid.');
  return {
    seconds,
    bitsPerSecond: ((after.bytes - before.bytes) * 8) / seconds,
    fps: frames === undefined ? null : frames / seconds,
    width: after.width ?? null,
    height: after.height ?? null,
    workMsPerFrame:
      frames && before.workSeconds !== undefined && after.workSeconds !== undefined
        ? ((after.workSeconds - before.workSeconds) * 1000) / frames
        : null,
  };
}

export function options(args: string[]) {
  const result = {
    codec: 'VP8',
    content: 'motion',
    hint: 'auto',
    phaseMs: 10000,
    bitrates: [2000000, 8000000],
  };
  for (const arg of args) {
    const match = /^--(codec|content|hint|phase-ms|bitrates-mbps)=(.+)$/.exec(arg);
    if (!match)
      throw new Error(
        'Expected --codec=VP8|H264|VP9|AV1, --content=motion|stress|text|static, --hint=auto|detail|motion|fixed, --bitrates-mbps=<screen bitrates> or --phase-ms=5000..60000.',
      );
    const [, key, value] = match;
    if (key === 'codec' && ['VP8', 'H264', 'VP9', 'AV1'].includes(value!)) result.codec = value!;
    else if (key === 'content' && ['motion', 'stress', 'text', 'static'].includes(value!))
      result.content = value!;
    else if (key === 'hint' && ['auto', 'detail', 'motion', 'fixed'].includes(value!))
      result.hint = value!;
    else if (key === 'bitrates-mbps') {
      const rates = value!.split(',').map((rate) => Number(rate) * 1000000);
      if (
        !/^\d+(,\d+)*$/.test(value!) ||
        rates.some((rate) => !feasibilityBitrates.includes(rate)) ||
        new Set(rates).size !== rates.length
      )
        throw new Error('Choose distinct supported screen bitrates.');
      result.bitrates = rates;
    } else if (
      key === 'phase-ms' &&
      /^\d+$/.test(value!) &&
      Number(value) >= 5000 &&
      Number(value) <= 60000
    )
      result.phaseMs = Number(value);
    else throw new Error('Invalid screen feasibility option: ' + arg);
  }
  return result;
}
