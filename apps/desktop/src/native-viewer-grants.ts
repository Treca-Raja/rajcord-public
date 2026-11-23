import type { NativeViewerSnapshot } from '@tricord/shared' with { 'resolution-mode': 'import' };

export const nativeLinkId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);

// Only authenticated main-process publication-check responses can populate these grants.
export class NativeViewerGrants {
  private viewers = new Map<string, { expires: number; answerHash: string | null }>();
  private waiting = new Set<() => void>();
  private ended = false;

  constructor(private readonly batchSize: number) {}

  observe(snapshot: NativeViewerSnapshot, started: number) {
    if (!Array.isArray(snapshot.viewers) || snapshot.viewers.length > this.batchSize)
      throw new Error('Invalid authorized native viewers.');
    const next = new Map<string, { expires: number; answerHash: string | null }>();
    for (const viewer of snapshot.viewers) {
      if (
        !nativeLinkId(viewer.id) ||
        next.has(viewer.id) ||
        !Number.isInteger(viewer.remainingMs) ||
        viewer.remainingMs <= 0 ||
        viewer.remainingMs > 45000 ||
        !(
          viewer.answerHash === null ||
          (typeof viewer.answerHash === 'string' && /^[a-f0-9]{64}$/.test(viewer.answerHash))
        )
      )
        throw new Error('Invalid native viewer authorization.');
      next.set(viewer.id, { expires: started + viewer.remainingMs, answerHash: viewer.answerHash });
    }
    this.viewers = next;
    for (const notify of [...this.waiting]) notify();
  }

  currentDeadline(id: string, answerHash?: string) {
    const grant = this.viewers.get(id);
    return !this.ended &&
      grant &&
      grant.expires > Date.now() &&
      (!answerHash || grant.answerHash === answerHash)
      ? grant.expires
      : 0;
  }

  async deadline(id: string, answerHash?: string) {
    const current = () => this.currentDeadline(id, answerHash);
    if (!current()) {
      if (this.ended) throw new Error('Native viewer admission closed.');
      if (this.waiting.size >= this.batchSize)
        throw new Error('Native viewer authorization is busy.');
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.waiting.delete(notify);
          clearTimeout(timer);
          resolve();
        };
        const notify = () => {
          if (this.ended || current()) finish();
        };
        const timer = setTimeout(finish, 3500);
        this.waiting.add(notify);
      });
    }
    const expires = current();
    if (!expires) throw new Error('The server did not authorize this native viewer.');
    return expires;
  }

  stop() {
    this.ended = true;
    this.viewers.clear();
    for (const notify of [...this.waiting]) notify();
  }
}
