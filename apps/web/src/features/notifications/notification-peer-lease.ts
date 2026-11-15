export function holdNotificationPeer(locks: LockManager, accountId: string, tabId: string) {
  const prefix = 'tricord-notification-peer:' + accountId + ':';
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  let failed!: (cause: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // The browser releases this lock when a document dies, even without React cleanup.
  const held = locks.request(prefix + tabId, async () => {
    ready();
    await lifetime;
  });
  void held.catch(failed);
  return {
    ready: acquired,
    async livePeers() {
      await acquired;
      const snapshot = await locks.query();
      return new Set(
        (snapshot.held ?? [])
          .map((lock) => lock.name)
          .filter((name): name is string => typeof name === 'string' && name.startsWith(prefix))
          .map((name) => name.slice(prefix.length)),
      );
    },
    close() {
      release();
      return held;
    },
  };
}
