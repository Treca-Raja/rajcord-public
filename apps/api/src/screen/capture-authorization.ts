import { randomUUID } from 'node:crypto';
import type { CaptureAuthorization, CaptureSoundChoice } from '@tricord/shared';
import { approved, equal, identity, type Identity } from '../auth/service.js';
import { HttpError, input, uuid } from '../auth/validation.js';
import type { Lease, VoiceService } from '../voice/service.js';

type Voice = Pick<
  VoiceService,
  'pool' | 'leases' | 'authorize' | 'exclusive' | 'onLeaseInvalidated'
>;
type Grant = {
  id: string;
  requestId: string;
  sound: CaptureSoundChoice;
  sessionId: string;
  lease: Lease;
  leaseId: string;
  channelId: string;
  expires: number;
  consumed: boolean;
};
const denied = () => new HttpError(403, 'Capture authorization is unavailable.');
export class CaptureAuthorizationService {
  private grants = new Map<string, Grant>();
  private requests = new WeakMap<Lease, Set<string>>();
  private accounts = new Map<string, { tokens: number; time: number; pending: number }>();
  private callers = new Map<string, { pending: number }>();
  private generation = 0;
  private pending = 0;
  private tokens = 120;
  private time: number;
  private disposed = false;
  private unsubscribe: () => void;
  constructor(
    private voice: Voice,
    private now: () => number = Date.now,
    private authenticate: (token: string) => Promise<Identity> = async (token) =>
      approved(await identity(voice.pool, token)),
  ) {
    this.time = now();
    this.unsubscribe = voice.onLeaseInvalidated((lease) => {
      if (this.grants.get(lease.userId)?.leaseId === lease.id) this.grants.delete(lease.userId);
    });
  }
  private admit(token: string) {
    if (this.disposed) throw new HttpError(503, 'Capture authorization is unavailable.');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Sign in required.');
    const now = this.now();
    this.tokens = Math.min(120, this.tokens + (Math.max(0, now - this.time) * 20) / 1000);
    this.time = now;
    const caller = this.callers.get(token) ?? { pending: 0 };
    if (this.tokens < 1 || this.pending >= 20 || caller.pending >= 2)
      throw new HttpError(429, 'Capture authorization is busy.');
    this.tokens--;
    this.pending++;
    caller.pending++;
    this.callers.set(token, caller);
    return () => {
      this.pending--;
      caller.pending--;
      if (!caller.pending) this.callers.delete(token);
    };
  }
  private admitAccount(userId: string) {
    const now = this.now();
    for (const [key, value] of this.accounts)
      if (!value.pending && now - value.time >= 60000) this.accounts.delete(key);
    // Only a verified identity can retain a rate bucket; cookie guesses retain pending work only.
    let account = this.accounts.get(userId);
    if (!account) {
      if (this.accounts.size >= 1024) throw new HttpError(429, 'Capture authorization is busy.');
      account = { tokens: 12, time: now, pending: 0 };
      this.accounts.set(userId, account);
    }
    account.tokens = Math.min(12, account.tokens + (Math.max(0, now - account.time) * 2) / 1000);
    account.time = now;
    if (account.tokens < 1 || account.pending >= 2)
      throw new HttpError(429, 'Capture authorization is busy.');
    account.tokens--;
    account.pending++;
    return () => {
      account.pending--;
    };
  }
  private current(grant: Grant) {
    return (
      !this.disposed &&
      this.voice.leases.get(grant.lease.userId) === grant.lease &&
      !grant.lease.revoked &&
      grant.lease.id === grant.leaseId &&
      grant.lease.sessionId === grant.sessionId &&
      grant.lease.channelId === grant.channelId &&
      Math.min(grant.expires, grant.lease.expires) > this.now()
    );
  }
  sweep() {
    for (const [id, grant] of this.grants) if (!this.current(grant)) this.grants.delete(id);
  }
  private value(grant: Grant): CaptureAuthorization {
    grant.expires = Math.min(grant.expires, grant.lease.expires);
    return { id: grant.id, remainingMs: Math.max(0, grant.expires - this.now()) };
  }
  private async session(token: string, csrf: unknown) {
    const auth = approved(await this.authenticate(token));
    if (!equal(csrf, auth.csrfToken)) throw new HttpError(403, 'Invalid CSRF token.');
    if (auth.expiresAt.getTime() <= this.now()) throw denied();
    return auth;
  }
  private run<T>(
    token: string,
    csrf: unknown,
    work: (auth: Identity, current: () => void) => Promise<T>,
  ) {
    const release = this.admit(token);
    const generation = this.generation;
    const current = () => {
      if (this.disposed || generation !== this.generation)
        throw new HttpError(503, 'Capture authorization is unavailable.');
    };
    return (async () => {
      let releaseAccount: (() => void) | undefined;
      try {
        const auth = await this.session(token, csrf);
        current();
        const userId = auth.user.id,
          sessionId = auth.sessionId;
        releaseAccount = this.admitAccount(userId);
        return await this.voice.exclusive(async () => {
          current();
          this.sweep();
          const fresh = await this.session(token, csrf);
          current();
          if (fresh.user.id !== userId || fresh.sessionId !== sessionId) throw denied();
          return work(fresh, current);
        });
      } catch (error) {
        if (
          generation === this.generation &&
          (!(error instanceof HttpError) || error.statusCode >= 500)
        ) {
          this.generation++;
          this.grants.clear();
        }
        throw error;
      } finally {
        releaseAccount?.();
        release();
      }
    })();
  }
  private async lease(token: string, auth: Identity) {
    const lease = this.voice.leases.get(auth.user.id);
    if (!lease || lease.sessionId !== auth.sessionId) throw denied();
    const verified = await this.voice.authorize(token, lease.id);
    if (
      verified !== lease ||
      this.voice.leases.get(auth.user.id) !== lease ||
      lease.revoked ||
      lease.expires <= this.now() ||
      auth.expiresAt.getTime() <= this.now()
    )
      throw denied();
    return lease;
  }
  prepare(token: string, value: unknown, csrf: unknown) {
    const body = input(value, ['requestId', 'sound']),
      requestId = uuid(body.requestId),
      sound = body.sound;
    if (sound !== 'none' && sound !== 'system')
      throw new HttpError(400, 'Invalid capture sound choice.');
    return this.run(token, csrf, async (auth, current) => {
      const lease = await this.lease(token, auth);
      current();
      let grant = this.grants.get(auth.user.id);
      if (grant) {
        if (
          grant.requestId !== requestId ||
          grant.sessionId !== auth.sessionId ||
          grant.lease !== lease
        )
          throw new HttpError(409, 'Another capture authorization is active.');
        if (grant.sound !== sound) throw new HttpError(400, 'Capture request changed.');
        if (grant.consumed) throw new HttpError(409, 'Capture authorization was consumed.');
      } else {
        let requests = this.requests.get(lease);
        if (requests?.has(requestId)) throw new HttpError(409, 'Capture request is obsolete.');
        if (this.grants.size >= 1024) throw new HttpError(429, 'Capture authorization is busy.');
        if (!requests) {
          requests = new Set();
          this.requests.set(lease, requests);
        }
        requests.add(requestId);
        if (requests.size > 64) requests.delete(requests.values().next().value!);
        grant = {
          id: randomUUID(),
          requestId,
          sound,
          sessionId: auth.sessionId,
          lease,
          leaseId: lease.id,
          channelId: lease.channelId,
          expires: Math.min(lease.expires, auth.expiresAt.getTime()),
          consumed: false,
        };
        this.grants.set(auth.user.id, grant);
      }
      grant.expires = Math.min(grant.expires, auth.expiresAt.getTime());
      if (!this.current(grant)) throw denied();
      return this.value(grant);
    });
  }
  verify(token: string, value: unknown, csrf: unknown, consume = false) {
    const id = uuid(input(value, ['id']).id);
    return this.run(token, csrf, async (auth, current) => {
      const grant = this.grants.get(auth.user.id);
      if (!grant || grant.id !== id || grant.sessionId !== auth.sessionId) throw denied();
      const lease = await this.lease(token, auth);
      current();
      if (!this.current(grant) || grant.lease !== lease || this.grants.get(auth.user.id) !== grant)
        throw denied();
      grant.expires = Math.min(grant.expires, auth.expiresAt.getTime());
      if (grant.expires <= this.now()) throw denied();
      if (consume) {
        if (grant.consumed) throw new HttpError(409, 'Capture authorization was consumed.');
        grant.consumed = true;
      }
      return this.value(grant);
    });
  }
  cancel(token: string, value: unknown, csrf: unknown) {
    const requestId = uuid(input(value, ['requestId']).requestId);
    return this.run(token, csrf, async (auth) => {
      const grant = this.grants.get(auth.user.id);
      if (grant?.requestId === requestId && grant.sessionId === auth.sessionId)
        this.grants.delete(auth.user.id);
      return { cancelled: true as const };
    });
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.grants.clear();
    this.accounts.clear();
    this.callers.clear();
    this.unsubscribe();
  }
}
