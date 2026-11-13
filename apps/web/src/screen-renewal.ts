// Minted by the trusted controller only after a newly completed authenticated
// renewal. Never accepted from UI/IPC JSON or treated as server authorization.
const issued = new WeakSet<object>();
export type ScreenRenewalPermit = Readonly<{
  generation: object;
  deadline: number;
  revision: number;
}>;
export function screenRenewalPermit(
  generation: object,
  deadline: number,
  revision: number,
): ScreenRenewalPermit {
  if (
    !generation ||
    !Number.isSafeInteger(deadline) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new Error('Invalid screen renewal.');
  const permit = Object.freeze({ generation, deadline, revision });
  issued.add(permit);
  return permit;
}
export function adoptScreenRenewal(
  permit: ScreenRenewalPermit,
  generation: object,
  previousDeadline: number,
  previousRevision: number,
  now: number,
) {
  if (
    !issued.has(permit) ||
    permit.generation !== generation ||
    previousDeadline <= now ||
    permit.deadline <= now ||
    permit.revision <= previousRevision
  )
    throw new Error('Screen renewal is obsolete or does not own this lifetime.');
  return permit;
}
