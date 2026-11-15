type Peer = {
  id: string;
  selected: string | null;
  focused: boolean;
  receiving: boolean;
  at: number;
};
type Ledger = { peers: Peer[]; seen: { id: string; at: number }[] };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Lock = <T>(work: () => T | Promise<T>) => Promise<T>;
export const notificationCoordinationLimits = { peers: 32, messages: 500, leaseMs: 6500 };
const maxAge = 10 * 60 * 1000;

export class NotificationCoordinator {
  private readonly key: string;
  constructor(
    accountId: string,
    private readonly tabId: string,
    private readonly store: Store,
    private readonly lock: Lock,
    private readonly now = Date.now,
    private readonly livePeers?: () => Promise<ReadonlySet<string>>,
  ) {
    this.key = 'tricord-notification-coordination:' + accountId;
  }
  private read(): Ledger {
    const raw = this.store.getItem(this.key);
    if (!raw) return { peers: [], seen: [] };
    if (raw.length > 150000) throw new Error('Notification coordination storage is invalid.');
    const value = JSON.parse(raw) as Ledger;
    if (
      !Array.isArray(value.peers) ||
      !Array.isArray(value.seen) ||
      value.peers.length > notificationCoordinationLimits.peers ||
      value.seen.length > notificationCoordinationLimits.messages
    )
      throw new Error('Notification coordination storage is invalid.');
    const now = this.now();
    return {
      peers: value.peers.filter(
        (peer) =>
          typeof peer.id === 'string' &&
          peer.id.length <= 100 &&
          (peer.selected === null || typeof peer.selected === 'string') &&
          typeof peer.focused === 'boolean' &&
          typeof peer.receiving === 'boolean' &&
          Number.isFinite(peer.at) &&
          peer.at <= now &&
          now - peer.at < notificationCoordinationLimits.leaseMs,
      ),
      seen: value.seen.filter(
        (entry) =>
          typeof entry.id === 'string' &&
          entry.id.length <= 100 &&
          Number.isFinite(entry.at) &&
          entry.at <= now &&
          now - entry.at < maxAge,
      ),
    };
  }
  private async current() {
    const live = await this.livePeers?.();
    const state = this.read();
    if (live) state.peers = state.peers.filter((peer) => live.has(peer.id));
    return state;
  }
  update(selected: string | null, focused: boolean, receiving = true) {
    return this.lock(async () => {
      const state = await this.current();
      state.peers = state.peers.filter((peer) => peer.id !== this.tabId);
      if (state.peers.length === notificationCoordinationLimits.peers)
        throw new Error('Too many Rajcord tabs. Close a tab to resume alerts.');
      state.peers.push({ id: this.tabId, selected, focused, receiving, at: this.now() });
      this.store.setItem(this.key, JSON.stringify(state));
    });
  }
  claim(messageId: string, conversationId: string) {
    return this.lock(async () => {
      const state = await this.current();
      if (state.seen.some((entry) => entry.id === messageId)) return 'duplicate' as const;
      const suppressed = state.peers.some(
        (peer) => peer.focused && peer.selected === conversationId,
      );
      const peers = state.peers
        .filter((peer) => peer.receiving)
        .sort((a, b) => Number(b.focused) - Number(a.focused) || a.id.localeCompare(b.id));
      if (!suppressed && peers[0]?.id !== this.tabId) return 'other-tab' as const;
      state.seen.push({ id: messageId, at: this.now() });
      state.seen = state.seen.slice(-notificationCoordinationLimits.messages);
      this.store.setItem(this.key, JSON.stringify(state));
      return suppressed ? ('suppressed' as const) : ('deliver' as const);
    });
  }
  close() {
    return this.lock(() => {
      const state = this.read();
      state.peers = state.peers.filter((peer) => peer.id !== this.tabId);
      this.store.setItem(this.key, JSON.stringify(state));
    });
  }
}
