import { ScreenError } from './service.js';

class Bucket {
  private tokens: number;
  private time: number;
  constructor(
    private rate: number,
    private burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.time = now;
  }
  take(amount: number, now: number) {
    this.tokens = Math.min(
      this.burst,
      this.tokens + (Math.max(0, now - this.time) * this.rate) / 1000,
    );
    this.time = now;
    if (amount > this.tokens)
      throw new ScreenError('throttled', 429, 'Screen budget exceeded. Retry later.');
    this.tokens -= amount;
  }
}
type Kind = 'control' | 'signal' | 'renew' | 'snapshot';
type Account = { last: number; pending: number; buckets: Record<Kind | 'bytes', Bucket> };
// Retain counters, never payloads. A writable transport has drained its previous writes.
export class ScreenOutput {
  private packets = 0;
  private bytes = 0;
  take(writable: boolean, payloads: unknown[]) {
    if (writable) {
      this.packets = 0;
      this.bytes = 0;
    }
    const bytes = payloads.reduce<number>(
      (sum, p) => sum + Buffer.byteLength(JSON.stringify(p)) + 64,
      0,
    );
    if (this.packets + payloads.length > 32 || this.bytes + bytes > 65536) return false;
    this.packets += payloads.length;
    this.bytes += bytes;
    return true;
  }
}
export class ScreenBudget {
  private accounts = new Map<string, Account>();
  private pending = 0;
  private aggregate: Record<Kind | 'bytes', Bucket>;
  constructor(private now: () => number = Date.now) {
    const time = now();
    this.aggregate = {
      control: new Bucket(10, 100, time),
      signal: new Bucket(1200, 1800, time),
      renew: new Bucket(2, 30, time),
      bytes: new Bucket(2621440, 5242880, time),
      snapshot: new Bucket(30, 30, time),
    };
  }
  acquire(accountId: string, kind: Kind, bytes: number): () => void {
    const time = this.now();
    for (const [id, value] of this.accounts)
      if (!value.pending && time - value.last >= 60000) this.accounts.delete(id);
    let account = this.accounts.get(accountId);
    if (!account) {
      if (this.accounts.size >= 1024)
        throw new ScreenError('throttled', 429, 'Screen budget capacity reached.');
      account = {
        last: time,
        pending: 0,
        buckets: {
          control: new Bucket(1, 10, time),
          signal: new Bucket(120, 180, time),
          renew: new Bucket(0.2, 3, time),
          bytes: new Bucket(262144, 524288, time),
          snapshot: new Bucket(1, 2, time),
        },
      };
      this.accounts.set(accountId, account);
    }
    account.last = time;
    this.aggregate[kind].take(1, time);
    account.buckets[kind].take(1, time);
    this.aggregate.bytes.take(bytes, time);
    account.buckets.bytes.take(bytes, time);
    if (this.pending >= 20 || account.pending >= 2)
      throw new ScreenError('throttled', 429, 'Screen authorization is busy. Retry later.');
    this.pending++;
    account.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
      account.pending--;
    };
  }
}
