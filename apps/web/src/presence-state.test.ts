import { describe, expect, it } from 'vitest';
import { applyPresenceDelta, groupPresence } from './presence-state';
import type { PresenceDelta, PresenceSnapshot } from '@tricord/shared';

describe('authoritative presence ordering', () => {
  const snapshot: PresenceSnapshot = { epoch: 'api-1', revision: 4, onlineIds: ['a'] };
  const delta = (revision: number, online: boolean): PresenceDelta => ({
    epoch: 'api-1',
    revision,
    changes: [{ userId: 'a', online }],
    rosterChanged: false,
  });
  it('ignores duplicate/stale disconnects after a newer snapshot', () => {
    expect(applyPresenceDelta(snapshot, delta(3, false))).toBe(snapshot);
    expect(applyPresenceDelta(snapshot, delta(4, false))).toBe(snapshot);
  });
  it('does not fabricate fresh status across a revision gap or API restart', () => {
    expect(applyPresenceDelta(snapshot, delta(6, false))).toBeNull();
    expect(applyPresenceDelta(snapshot, { ...delta(5, false), epoch: 'api-2' })).toBeNull();
  });
  it('applies buffered changes newer than a snapshot without counting connections', () => {
    const offline = applyPresenceDelta(snapshot, delta(5, false))!;
    const online = applyPresenceDelta(offline, delta(6, true))!;
    expect(online.onlineIds).toEqual(['a']);
    expect(applyPresenceDelta(online, delta(6, true))!.onlineIds).toEqual(['a']);
  });
});

describe('eligible scoped roster grouping', () => {
  const member = (id: string, displayName = 'Same', username = id, status = 'approved') => ({
    id,
    displayName,
    username,
    status,
  });
  it('counts distinct eligible roster members, excluding other community IDs and unavailable accounts', () => {
    const groups = groupPresence(
      [member('a'), member('a'), member('b'), member('c', 'Gone', 'gone', 'suspended')],
      ['a', 'c', 'outside'],
    );
    expect(groups.online.map((m) => m.id)).toEqual(['a']);
    expect(groups.offline.map((m) => m.id)).toEqual(['b']);
    expect(groups.unavailable.map((m) => m.id)).toEqual(['c']);
  });
  it('sorts names then usernames then stable IDs and preserves offline message targets', () => {
    const groups = groupPresence(
      [
        member('z', 'Zed'),
        member('b', 'Same', 'same'),
        member('a', 'Same', 'same'),
        member('c', 'Same', 'aaa'),
      ],
      [],
    );
    expect(groups.offline.map((m) => m.id)).toEqual(['c', 'a', 'b', 'z']);
    expect(groups.online).toEqual([]);
    expect(groupPresence([], []).offline).toEqual([]);
  });
});
