import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthState } from '@tricord/shared';
import { VerifiedVoiceSessions } from './voice-session';

const owners: VerifiedVoiceSessions[] = [];
function setup() {
  const owner = new VerifiedVoiceSessions();
  owners.push(owner);
  return owner;
}
function verified(overrides: Partial<AuthState> = {}): AuthState {
  return {
    user: {
      id: 'account',
      username: 'fixture',
      displayName: 'Fixture',
      status: 'approved',
      isOwner: false,
    },
    csrfToken: 'session-a',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    remember: false,
    ...overrides,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  owners.forEach((owner) => owner.invalidate());
  owners.length = 0;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('preserves one lifetime for fresh verified responses from the same session and updates its request callback', async () => {
  const owner = setup(),
    old = vi.fn().mockResolvedValue('old'),
    current = vi.fn().mockResolvedValue('current');
  const first = owner.acceptVerified(verified(), old)!;
  const ended = vi.fn();
  first.onEnd(ended);
  expect(owner.acceptVerified(verified(), current)).toBe(first);
  expect(await first.request('/voice/channels')).toBe('current');
  expect(old).not.toHaveBeenCalled();
  expect(ended).not.toHaveBeenCalled();
});
it('same-account session replacement synchronously invalidates only the old lifetime and retains its cleanup callback', async () => {
  const owner = setup(),
    old = vi.fn().mockResolvedValue('old'),
    current = vi.fn().mockResolvedValue('new');
  const first = owner.acceptVerified(verified(), old)!,
    ended = vi.fn();
  first.onEnd(ended);
  const next = owner.acceptVerified(verified({ csrfToken: 'session-b' }), current)!;
  expect(first.current).toBe(false);
  expect(ended).toHaveBeenCalledOnce();
  expect(next.current).toBe(true);
  first.invalidate();
  expect(next.current).toBe(true);
  expect(await first.request('/voice/leave', 'POST', { leaseId: 'old' })).toBe('old');
  expect(current).not.toHaveBeenCalled();
});
it.each(['pending', 'rejected', 'suspended', 'removed'] as const)(
  'a verified %s response synchronously ends the approved call',
  (status) => {
    const owner = setup(),
      state = verified(),
      first = owner.acceptVerified(state, vi.fn())!,
      ended = vi.fn();
    first.onEnd(ended);
    expect(owner.acceptVerified({ ...state, user: { ...state.user, status } }, vi.fn())).toBeNull();
    expect(ended).toHaveBeenCalledOnce();
    expect(first.current).toBe(false);
  },
);
it('invalidation is immediate and idempotent and stale unsubscribe cannot remove a replacement listener', () => {
  const owner = setup(),
    first = owner.acceptVerified(verified(), vi.fn())!,
    ended = vi.fn();
  const unsubscribe = first.onEnd(ended);
  owner.invalidate();
  owner.invalidate();
  expect(ended).toHaveBeenCalledOnce();
  const late = vi.fn();
  first.onEnd(late);
  expect(late).toHaveBeenCalledOnce();
  const next = owner.acceptVerified(verified(), vi.fn())!,
    nextEnded = vi.fn();
  next.onEnd(nextEnded);
  unsubscribe();
  expect(next.current).toBe(true);
  owner.invalidate();
  expect(nextEnded).toHaveBeenCalledOnce();
});
it.each(['invalid', new Date(0).toISOString()])(
  'expired or malformed verified expiry %s cannot keep a call alive',
  (expiresAt) => {
    const owner = setup(),
      first = owner.acceptVerified(verified(), vi.fn())!;
    expect(owner.acceptVerified(verified({ expiresAt }), vi.fn())).toBeNull();
    expect(first.current).toBe(false);
  },
);
it('expiry is a hard stop and an old deadline cannot stop a replacement session', () => {
  const owner = setup(),
    first = owner.acceptVerified(verified(), vi.fn())!;
  vi.advanceTimersByTime(30_000);
  const next = owner.acceptVerified(verified({ csrfToken: 'b' }), vi.fn())!;
  vi.advanceTimersByTime(30_001);
  expect(first.current).toBe(false);
  expect(next.current).toBe(true);
  vi.advanceTimersByTime(29_999);
  expect(next.current).toBe(false);
});
it('remembered-session deadlines do not overflow native timers and cannot be extended by mutating a response', () => {
  const owner = setup(),
    lifetime = 30 * 86400_000,
    state = verified({ expiresAt: new Date(Date.now() + lifetime).toISOString() });
  const session = owner.acceptVerified(state, vi.fn())!;
  state.expiresAt = new Date(Date.now() + lifetime * 2).toISOString();
  vi.advanceTimersByTime(2_147_483_647);
  expect(session.current).toBe(true);
  vi.advanceTimersByTime(lifetime - 2_147_483_647);
  expect(session.current).toBe(false);
});
it('missing verified identity invalidates the owned call', () => {
  const owner = setup(),
    session = owner.acceptVerified(verified(), vi.fn())!;
  expect(owner.acceptVerified(null, vi.fn())).toBeNull();
  expect(session.current).toBe(false);
});
