import type { ScreenVideoPlan } from './screen-quality';
import type { ScreenContentKind } from './screen-content';

export function screenAdaptiveVideoPlan(
  plan: ScreenVideoPlan,
  budget: number,
  content: ScreenContentKind,
): ScreenVideoPlan {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid screen video budget.');
  // A bitrate ceiling is not evidence that frames need downscaling. WebRTC adapts
  // to measured congestion/encoder load using the current content preference.
  return Object.freeze({
    ...plan,
    content,
    encoding: Object.freeze({
      ...plan.encoding,
      maxBitrate: Math.min(plan.encoding.maxBitrate, Math.max(1, Math.floor(budget))),
    }),
  });
}

export function screenVideoBudget(ceilings: readonly number[], total: number): readonly number[] {
  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    ceilings.some((value) => !Number.isFinite(value) || value <= 0)
  )
    throw new Error('Invalid screen video budget.');
  let remaining = total;
  const allocations = ceilings.map(() => 0);
  const pending = new Set(ceilings.map((_, index) => index));
  while (pending.size) {
    const fair = remaining / pending.size;
    const satisfied = [...pending].filter((index) => ceilings[index]! <= fair);
    if (!satisfied.length) {
      for (const index of pending) allocations[index] = Math.floor(fair);
      break;
    }
    for (const index of satisfied) {
      allocations[index] = ceilings[index]!;
      remaining -= ceilings[index]!;
      pending.delete(index);
    }
  }
  return Object.freeze(allocations);
}
