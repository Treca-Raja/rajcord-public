import { randomUUID } from 'node:crypto';
import type { CaptureAuthorization, CaptureSoundChoice } from '@tricord/shared';
import { approved, equal, identity, type Identity } from '../auth/service.js';
import { HttpError, input, uuid } from '../auth/validation.js';
import type { Lease, VoiceService } from '../voice/service.js';

type Voice = Pick<
  VoiceService,
  'pool' | 'leases' | 'authorize' | 'exclusive' | 'onLeaseInvalidated'
>;
export type CaptureBindingMatcher = (
  userId: string,
  sessionId: string,
  lease: Lease,
  epoch: string,
) => object | null;
export type CapturePublicationMatcher = (
  userId: string,
  sessionId: string,
  lease: Lease,
  epoch: string,
  shareId: string,
  sourceGeneration: number,
  sound: string,
) => { identity: object; expires: number } | null;
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
  epoch: string;
  binding: object;
  promoted?: string;
};
type Publication = Omit<Grant, 'consumed' | 'promoted'> & {
  previewId: string;
  shareId: string;
  sourceGeneration: number;
  share: object;
  issuedExpires: number;
  revision: number;
  fingerprint?: string;
  checkedExpires?: number;
};
const denied = () => new HttpError(403, 'Capture authorization is unavailable.');
export class CaptureAuthorizationService {
  private grants = new Map<string, Grant>();
  private publications = new Map<string, Publication>();
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
    private matchBinding: CaptureBindingMatcher = () => null,
    private matchPublication: CapturePublicationMatcher = () => null,
  ) {
    this.time = now();
    this.unsubscribe = voice.onLeaseInvalidated((lease) => {
      if (this.grants.get(lease.userId)?.leaseId === lease.id) this.grants.delete(lease.userId);
      if (this.publications.get(lease.userId)?.leaseId === lease.id)
        this.publications.delete(lease.userId);
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
  private current(grant: Omit<Grant, 'consumed'>) {
    return (
      !this.disposed &&
      this.voice.leases.get(grant.lease.userId) === grant.lease &&
      !grant.lease.revoked &&
      grant.lease.id === grant.leaseId &&
      grant.lease.sessionId === grant.sessionId &&
      grant.lease.channelId === grant.channelId &&
      this.matchBinding(grant.lease.userId, grant.sessionId, grant.lease, grant.epoch) ===
        grant.binding &&
      Math.min(grant.expires, grant.lease.expires) > this.now()
    );
  }
  sweep() {
    for (const [id, grant] of this.grants) if (!this.current(grant)) this.grants.delete(id);
    for (const [id, publication] of this.publications)
      if (!this.current(publication) || !this.ownPublication(publication))
        this.publications.delete(id);
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
          this.publications.clear();
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
    const body = input(value, ['requestId', 'sound', 'epoch']),
      requestId = uuid(body.requestId),
      epoch = uuid(body.epoch),
      sound = body.sound;
    if (sound !== 'none' && sound !== 'system')
      throw new HttpError(400, 'Invalid capture sound choice.');
    return this.run(token, csrf, async (auth, current) => {
      const lease = await this.lease(token, auth);
      current();
      const binding = this.matchBinding(auth.user.id, auth.sessionId, lease, epoch);
      if (!binding) throw denied();
      let grant = this.grants.get(auth.user.id);
      if (grant) {
        if (
          grant.requestId !== requestId ||
          grant.sessionId !== auth.sessionId ||
          grant.lease !== lease
        )
          throw new HttpError(409, 'Another capture authorization is active.');
        if (grant.sound !== sound || grant.epoch !== epoch || grant.binding !== binding)
          throw new HttpError(400, 'Capture request changed.');
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
          epoch,
          binding,
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
  private ownPublication(publication: Publication) {
    const own = this.matchPublication(
      publication.lease.userId,
      publication.sessionId,
      publication.lease,
      publication.epoch,
      publication.shareId,
      publication.sourceGeneration,
      publication.sound,
    );
    return own?.identity === publication.share ? own : null;
  }
  handoff(token: string, value: unknown, csrf: unknown) {
    const body = input(value, ['id', 'epoch', 'shareId', 'sourceGeneration', 'requestId']);
    const id = uuid(body.id),
      epoch = uuid(body.epoch),
      shareId = uuid(body.shareId),
      requestId = uuid(body.requestId);
    const sourceGeneration = body.sourceGeneration;
    if (!Number.isSafeInteger(sourceGeneration) || (sourceGeneration as number) < 1)
      throw new HttpError(400, 'Invalid screen source generation.');
    return this.run(token, csrf, async (auth, current) => {
      const lease = await this.lease(token, auth);
      current();
      const preview = this.grants.get(auth.user.id);
      if (
        !preview ||
        preview.id !== id ||
        preview.epoch !== epoch ||
        preview.lease !== lease ||
        preview.sessionId !== auth.sessionId ||
        !preview.consumed ||
        !this.current(preview)
      )
        throw denied();
      const own = this.matchPublication(
        auth.user.id,
        auth.sessionId,
        lease,
        epoch,
        shareId,
        sourceGeneration as number,
        preview.sound,
      );
      if (!own) throw denied();
      const previous = this.publications.get(auth.user.id);
      if (previous) {
        if (
          previous.requestId !== requestId ||
          previous.previewId !== id ||
          previous.shareId !== shareId ||
          previous.sourceGeneration !== sourceGeneration ||
          !this.current(previous) ||
          this.ownPublication(previous)?.identity !== own.identity
        )
          throw denied();
        return {
          id: previous.id,
          remainingMs: Math.max(
            0,
            Math.min(
              previous.issuedExpires,
              previous.expires,
              own.expires,
              auth.expiresAt.getTime(),
            ) - this.now(),
          ),
        };
      }
      if (preview.promoted) throw denied();
      const publication: Publication = {
        ...preview,
        id: randomUUID(),
        previewId: preview.id,
        requestId,
        shareId,
        sourceGeneration: sourceGeneration as number,
        share: own.identity,
        expires: Math.min(own.expires, auth.expiresAt.getTime()),
        issuedExpires: Math.min(own.expires, auth.expiresAt.getTime()),
        revision: 0,
      };
      preview.promoted = publication.id;
      this.publications.set(auth.user.id, publication);
      return { id: publication.id, remainingMs: publication.expires - this.now() };
    });
  }
  checkPublication(token: string, value: unknown, csrf: unknown) {
    const body = input(value, ['id', 'requestId', 'revision']);
    const id = uuid(body.id),
      requestId = uuid(body.requestId),
      revision = body.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1)
      throw new HttpError(400, 'Invalid publication revision.');
    return this.run(token, csrf, async (auth, current) => {
      const publication = this.publications.get(auth.user.id);
      if (
        !publication ||
        publication.id !== id ||
        publication.sessionId !== auth.sessionId ||
        !this.current(publication)
      )
        throw denied();
      const lease = await this.lease(token, auth);
      current();
      const own = this.ownPublication(publication);
      if (
        !own ||
        lease !== publication.lease ||
        this.publications.get(auth.user.id) !== publication ||
        !this.current(publication)
      )
        throw denied();
      const fingerprint = JSON.stringify([requestId, revision]);
      if (
        (revision as number) < publication.revision ||
        (revision === publication.revision && fingerprint !== publication.fingerprint)
      )
        throw denied();
      if (revision !== publication.revision) {
        publication.expires = Math.min(own.expires, auth.expiresAt.getTime());
        publication.checkedExpires = publication.expires;
        publication.revision = revision as number;
        publication.fingerprint = fingerprint;
      }
      const remainingMs =
        Math.min(
          publication.checkedExpires!,
          publication.expires,
          own.expires,
          auth.expiresAt.getTime(),
        ) - this.now();
      if (remainingMs <= 0) throw denied();
      return { id: publication.id, remainingMs };
    });
  }
  cancelPublication(token: string, value: unknown, csrf: unknown) {
    const id = uuid(input(value, ['id']).id);
    return this.run(token, csrf, async (auth) => {
      const publication = this.publications.get(auth.user.id);
      if (publication?.id === id && publication.sessionId === auth.sessionId)
        this.publications.delete(auth.user.id);
      return { cancelled: true as const };
    });
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.grants.clear();
    this.publications.clear();
    this.accounts.clear();
    this.callers.clear();
    this.unsubscribe();
  }
}
