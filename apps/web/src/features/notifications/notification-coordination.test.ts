import { expect, it } from 'vitest';
import {
  NotificationCoordinator,
  notificationCoordinationLimits,
} from './notification-coordination';

function fixture(live?: Set<string>) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let pending = Promise.resolve();
  const lock = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let now = 10000;
  const tab = (id: string, account = 'account') =>
    new NotificationCoordinator(
      account,
      id,
      storage,
      lock,
      () => now,
      live ? async () => new Set(live) : undefined,
    );
  return {
    tab,
    values,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it('atomically gives one cooperating tab one delivery, including mention plus reply', async () => {
  const { tab } = fixture();
  const a = tab('a'),
    b = tab('b');
  await Promise.all([a.update(null, false), b.update(null, false)]);
  const outcomes = await Promise.all([
    b.claim('message', 'room'),
    a.claim('message', 'room'),
    a.claim('message', 'room'),
    b.claim('message', 'room'),
  ]);
  expect(outcomes.filter((outcome) => outcome === 'deliver')).toHaveLength(1);
  expect(outcomes).toEqual(['other-tab', 'deliver', 'duplicate', 'duplicate']);
});
it('suppresses selected focused conversations across tabs, even if a background tab races first', async () => {
  const { tab } = fixture();
  const a = tab('a'),
    b = tab('b');
  await a.update(null, false);
  await b.update('room', true);
  expect(await a.claim('message', 'room')).toBe('suppressed');
  expect(await b.claim('message', 'room')).toBe('duplicate');
  expect(await a.claim('other', 'elsewhere')).toBe('other-tab');
  expect(await b.claim('other', 'elsewhere')).toBe('deliver');
});
it('recovers ownership after tab closure or lease expiry without sharing across accounts', async () => {
  const { tab, advance } = fixture();
  const a = tab('a'),
    b = tab('b'),
    other = tab('c', 'other');
  await Promise.all([a.update(null, false), b.update(null, false), other.update(null, false)]);
  expect(await other.claim('message', 'room')).toBe('deliver');
  expect(await a.claim('message', 'room')).toBe('deliver');
  await a.close();
  expect(await b.claim('next', 'room')).toBe('deliver');
  await a.update('room', true);
  advance(notificationCoordinationLimits.leaseMs + 1);
  await b.update(null, false);
  expect(await b.claim('last', 'room')).toBe('deliver');
});
it('does not elect a disconnected tab as the delivery owner', async () => {
  const { tab } = fixture();
  const a = tab('a'),
    b = tab('b');
  await a.update(null, true, false);
  await b.update(null, false, true);
  expect(await b.claim('message', 'room')).toBe('deliver');
  await a.update('room', true, false);
  expect(await b.claim('selected', 'room')).toBe('suppressed');
});
it('does not suppress the first post-reload notice using the previous document lease', async () => {
  const live = new Set(['old-page']);
  const { tab, values } = fixture(live);
  const previous = tab('old-page');
  await previous.update('dm', true);
  // Reload kills the document lock without running component cleanup or advancing the lease.
  live.delete('old-page');
  live.add('new-page');
  const reloaded = tab('new-page');
  await reloaded.update('general', false);
  expect(await reloaded.claim('new-message', 'dm')).toBe('deliver');
  expect(await reloaded.claim('new-message', 'dm')).toBe('duplicate');
  expect(JSON.parse([...values.values()][0]!).peers.map((peer: { id: string }) => peer.id)).toEqual(
    ['new-page'],
  );
});
it('does not elect a dead document before its heartbeat lease expires', async () => {
  const live = new Set(['a', 'b']);
  const { tab } = fixture(live);
  const dead = tab('a'),
    surviving = tab('b');
  await dead.update('general', true);
  await surviving.update(null, false);
  live.delete('a');
  expect(await surviving.claim('message', 'dm')).toBe('deliver');
});
it('bounds tab leases and dedup memory and fails closed on broken coordination', async () => {
  const { tab, values } = fixture();
  const a = tab('a');
  await a.update(null, false);
  for (let index = 0; index < 510; index++) await a.claim('m' + index, 'room');
  const stored = JSON.parse([...values.values()][0]!);
  expect(stored.seen).toHaveLength(500);
  expect(await a.claim('m509', 'room')).toBe('duplicate');
  for (let index = 0; index < 31; index++) await tab('t' + index).update(null, false);
  await expect(tab('extra').update(null, false)).rejects.toThrow('Too many');
  values.set([...values.keys()][0]!, '{broken');
  await expect(a.claim('message', 'room')).rejects.toThrow();
});
