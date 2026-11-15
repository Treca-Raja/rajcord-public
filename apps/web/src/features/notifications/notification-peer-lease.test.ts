import { expect, it } from 'vitest';
import { holdNotificationPeer } from './notification-peer-lease';

it('holds a document lifetime marker and scopes live peers to the account', async () => {
  const held = new Set<string>();
  const locks = {
    async request(name: string, callback: () => Promise<void>) {
      held.add(name);
      try {
        await callback();
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name })), pending: [] };
    },
  } as unknown as LockManager;
  const first = holdNotificationPeer(locks, 'account', 'a');
  const second = holdNotificationPeer(locks, 'account', 'b');
  const other = holdNotificationPeer(locks, 'other', 'c');
  await Promise.all([first.ready, second.ready, other.ready]);
  expect(await first.livePeers()).toEqual(new Set(['a', 'b']));
  await first.close();
  expect(await second.livePeers()).toEqual(new Set(['b']));
  expect(await other.livePeers()).toEqual(new Set(['c']));
  await Promise.all([second.close(), other.close()]);
  expect(held.size).toBe(0);
});
