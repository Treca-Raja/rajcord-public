import type { PresenceDelta, PresenceSnapshot } from '@tricord/shared';

export function applyPresenceDelta(
  snapshot: PresenceSnapshot,
  delta: PresenceDelta,
): PresenceSnapshot | null {
  if (delta.epoch !== snapshot.epoch) return null;
  if (delta.revision <= snapshot.revision) return snapshot;
  if (delta.revision !== snapshot.revision + 1) return null;
  const online = new Set(snapshot.onlineIds);
  for (const change of delta.changes) {
    if (change.online) online.add(change.userId);
    else online.delete(change.userId);
  }
  return { epoch: snapshot.epoch, revision: delta.revision, onlineIds: [...online] };
}

export type RosterMember = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};
export function groupPresence(roster: RosterMember[], onlineIds: string[]) {
  const online = new Set(onlineIds);
  const sorted = [...new Map(roster.map((member) => [member.id, member])).values()].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.username.localeCompare(b.username) ||
      a.id.localeCompare(b.id),
  );
  return {
    online: sorted.filter((m) => m.status === 'approved' && online.has(m.id)),
    offline: sorted.filter((m) => m.status === 'approved' && !online.has(m.id)),
    unavailable: sorted.filter((m) => m.status !== 'approved'),
  };
}
