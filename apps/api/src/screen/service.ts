import { screenRelayServers } from './relay.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  SCREEN_PROTOCOL_VERSION,
  NATIVE_VIEWER_GRANT_BATCH_SIZE,
  SCREEN_RENEWAL_PAGE_SIZE,
  SCREEN_PROFILES,
  SCREEN_VIDEO_BITRATES,
  SCREEN_RESOLUTIONS,
  SCREEN_FRAME_RATES,
  sameScreenQuality,
  type ScreenBinding,
  type ScreenErrorCode,
  type ScreenQuality,
  type ScreenShare,
  type ScreenPublishGrant,
  type ScreenLink,
  type ScreenLinkGrant,
  type ScreenRenewal,
  type ScreenVideoBitrate,
  type ScreenDirectory,
  type ScreenSignalNotice,
} from '@tricord/shared';
import { HttpError, input, uuid } from '../auth/validation.js';
import type { Lease, VoiceService } from '../voice/service.js';
import { description, signal, type Description } from './signaling.js';

// Identity and connectivity come from the authenticated server transport.
export type ScreenCaller = {
  token: string;
  transportId: string;
  isConnected: () => boolean;
  supportsMoreThanNineViewers?: boolean;
  renewalPages?: boolean;
  directoryChanges?: boolean;
};
type Voice = Pick<
  VoiceService,
  'leases' | 'authorize' | 'authorizeBatch' | 'exclusive' | 'onLeaseInvalidated' | 'config'
>;
type Binding = {
  lease: Lease;
  leaseId: string;
  userId: string;
  sessionId: string;
  channelId: string;
  transportId: string;
  supportsMoreThanNineViewers: boolean;
  renewalPages: boolean;
  epoch: string;
  sourceGeneration: number;
  selectionRevision: number;
  isConnected: () => boolean;
  requests: Map<string, string>;
  renewalRevision: number;
  share?: Share;
  selections: Map<string, Link>;
  lastPublish?: string;
  lastSelection?: string;
  lastRenewal?: string;
  renewal?: {
    expires: number;
    links: { link: Link; expires: number }[];
    publication: { share: Share; expires: number } | null;
  };
};
type Share = {
  value: ScreenShare;
  publisher: Binding;
  native: boolean;
  nativeViewerBatch?: true;
  viewers: Set<Link>;
  expires: number;
  publishExpires: number;
  qualityRevision: number;
};
type Link = {
  value: Omit<ScreenLink, 'quality' | 'videoBitrate'>;
  share: Share;
  viewer: Binding;
  expires: number;
  negotiation?: {
    revision: number;
    offer: Description;
    answer?: Description;
    answerHash?: string;
    deadline: number;
    early: number;
    candidates: [number, number];
  };
  sequences?: [number, number];
};
export type ScreenSnapshot = { directory: ScreenDirectory; links: ScreenLinkGrant[] };
type SnapshotMembership = { shares: ReadonlyMap<string, ScreenShare>; links: ReadonlySet<string> };
export type ScreenDestination = { transportId: string; epoch: string };

export class ScreenError extends HttpError {
  constructor(
    readonly code: ScreenErrorCode,
    status: number,
    message: string,
  ) {
    super(status, message);
  }
}
const stale = () => new ScreenError('stale', 409, 'Screen state changed. Refresh before retrying.');
const denied = () => new ScreenError('not_authorized', 404, 'Screen share is unavailable.');
function revision(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ScreenError('invalid', 400, 'Invalid screen revision.');
  return value;
}
function quality(body: Record<string, unknown>): ScreenQuality {
  const explicit = body.resolution !== undefined || body.frameRate !== undefined;
  if (
    !(SCREEN_PROFILES as readonly unknown[]).includes(body.profile) ||
    (body.videoBitrate !== null &&
      !(SCREEN_VIDEO_BITRATES as readonly unknown[]).includes(body.videoBitrate)) ||
    (explicit &&
      (!(SCREEN_RESOLUTIONS as readonly unknown[]).includes(body.resolution) ||
        !(SCREEN_FRAME_RATES as readonly unknown[]).includes(body.frameRate)))
  )
    throw new ScreenError('invalid', 400, 'Invalid screen quality or video bitrate.');
  return {
    profile: body.profile as ScreenQuality['profile'],
    videoBitrate: body.videoBitrate as ScreenVideoBitrate,
    ...(explicit
      ? {
          resolution: body.resolution as ScreenQuality['resolution'],
          frameRate: body.frameRate as ScreenQuality['frameRate'],
        }
      : {}),
  };
}

export class ScreenService {
  private bindings = new Map<string, Binding>();
  private shares = new Map<string, Share>();
  private links = new Map<string, Link>();
  private disposed = false;
  private unsubscribe: () => void;
  private stateRevision = 1;
  // Called synchronously inside the caller's existing voice.exclusive section.
  // The returned identity is retained internally; an epoch is never authority.
  captureBinding(userId: string, sessionId: string, lease: Lease, epoch: string): object | null {
    const binding = this.bindings.get(userId);
    return binding &&
      binding.lease === lease &&
      binding.sessionId === sessionId &&
      binding.channelId === lease.channelId &&
      binding.epoch === epoch &&
      this.current(binding)
      ? binding
      : null;
  }
  capturePublication(
    userId: string,
    sessionId: string,
    lease: Lease,
    epoch: string,
    shareId: string,
    sourceGeneration: number,
    sound: string,
  ) {
    if (!this.captureBinding(userId, sessionId, lease, epoch)) return null;
    const share = this.bindings.get(userId)?.share;
    return share &&
      share.value.id === shareId &&
      share.value.sourceGeneration === sourceGeneration &&
      share.value.sound === sound &&
      share.expires > this.now()
      ? {
          identity: share,
          expires: Math.min(share.expires, lease.expires),
          enableNativeViewerBatch: share.native
            ? () => (share.nativeViewerBatch = true)
            : undefined,
        }
      : null;
  }
  private relayConfig(binding: Binding) {
    const iceServers = screenRelayServers(this.voice.config, binding.userId, this.now());
    return iceServers ? { iceServers } : {};
  }
  async nativeViewers(shareIdentity: object, userId: string) {
    const publisher = this.bindings.get(userId);
    const share = publisher?.share;
    if (!publisher || share !== shareIdentity || !this.current(publisher)) throw denied();
    const links = [...share.viewers].filter(
      ({ viewer, expires }) => expires > this.now() && this.current(viewer),
    );
    if (links.length)
      await this.endpoints(publisher, new Set(links.map(({ viewer }) => viewer)), true);
    if (publisher.share !== shareIdentity || !this.current(publisher)) throw denied();
    const viewers = [];
    for (const link of links) {
      const { value, viewer, share, expires, negotiation } = link;
      if (this.links.get(value.id) !== link || !this.current(viewer)) continue;
      const remainingMs = Math.min(expires, viewer.lease.expires, share.expires) - this.now();
      if (remainingMs > 0)
        viewers.push({ id: value.id, remainingMs, answerHash: negotiation?.answerHash ?? null });
    }
    return {
      viewers,
      iceServers: this.relayConfig(publisher).iceServers ?? [
        { urls: ['stun:stun.cloudflare.com:3478'] },
      ],
    };
  }
  private listeners = new Set<() => void>();
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    this.stateRevision++;
    for (const listener of this.listeners) listener();
  }
  constructor(
    private voice: Voice,
    private now: () => number = Date.now,
  ) {
    this.unsubscribe = voice.onLeaseInvalidated((lease) => {
      const binding = this.bindings.get(lease.userId);
      if (binding?.leaseId === lease.id) this.dropBinding(binding);
    });
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    return this.voice.exclusive(async () => {
      if (this.disposed)
        throw new ScreenError('unavailable', 503, 'Screen sharing is unavailable.');
      this.prune();
      return work();
    });
  }
  private current(binding: Binding) {
    const lease = binding.lease;
    return (
      !this.disposed &&
      binding.isConnected() &&
      this.bindings.get(binding.userId) === binding &&
      this.voice.leases.get(binding.userId) === lease &&
      !lease.revoked &&
      lease.expires > this.now() &&
      lease.id === binding.leaseId &&
      lease.sessionId === binding.sessionId &&
      lease.channelId === binding.channelId
    );
  }
  private check(binding: Binding) {
    if (!this.current(binding)) {
      this.dropBinding(binding);
      throw stale();
    }
  }
  private async lease(token: string, leaseId: string, expected?: Binding) {
    try {
      return await this.voice.authorize(token, leaseId);
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.statusCode)) {
        if (expected?.lease.token === token) this.dropBinding(expected);
        throw new ScreenError('not_authorized', error.statusCode, 'Screen authorization ended.');
      }
      // Authorization outages discard all ephemeral grants; no cached identity is a fallback.
      this.clear();
      throw error;
    }
  }
  private findBinding(caller: ScreenCaller, epoch: unknown) {
    if (!caller.isConnected()) throw stale();
    const id = uuid(epoch);
    const binding = [...this.bindings.values()].find(
      (b) => b.transportId === caller.transportId && b.epoch === id,
    );
    if (!binding) throw stale();
    return binding;
  }
  private async bound(caller: ScreenCaller, epoch: unknown) {
    const binding = this.findBinding(caller, epoch);
    const lease = await this.lease(caller.token, binding.leaseId, binding);
    this.check(binding);
    if (lease !== binding.lease) throw stale();
    return binding;
  }
  private async pair(caller: Binding, peer: Binding) {
    await this.endpoints(caller, new Set([peer]));
  }
  private async endpoints(caller: Binding, peers: Set<Binding>, dropUnauthorizedPeers = false) {
    const endpoints = [...peers].filter((peer) => peer !== caller);
    endpoints.push(caller);
    let results: Awaited<ReturnType<VoiceService['authorizeBatch']>>;
    try {
      results = await this.voice.authorizeBatch(
        endpoints.map((binding) => ({
          token: binding.lease.token,
          credential: binding.leaseId,
        })),
      );
    } catch (error) {
      this.clear();
      throw error;
    }
    let droppedPeer = false;
    for (const [index, binding] of endpoints.entries()) {
      const lease = results[index];
      if (
        dropUnauthorizedPeers &&
        binding !== caller &&
        (lease instanceof HttpError || !this.current(binding))
      ) {
        this.dropBinding(binding);
        droppedPeer = true;
        continue;
      }
      if (lease instanceof HttpError) {
        this.dropBinding(binding);
        throw new ScreenError('not_authorized', lease.statusCode, 'Screen authorization ended.');
      }
      this.check(binding);
      if (lease !== binding.lease || caller.channelId !== binding.channelId) throw denied();
    }
    return droppedPeer;
  }
  private shareValue(share: Share): ScreenShare {
    return { ...share.value };
  }
  private publication(share: Share, expires: number): ScreenPublishGrant {
    if (share.publisher.share !== share || this.shares.get(share.value.id) !== share) throw stale();
    const remainingMs =
      Math.min(expires, share.expires, share.publisher.lease.expires) - this.now();
    if (remainingMs <= 0) throw stale();
    return { share: this.shareValue(share), remainingMs };
  }
  private request(binding: Binding, id: string, fingerprint: string, commit = false) {
    const previous = binding.requests.get(id);
    if (previous !== undefined && previous !== fingerprint)
      throw new ScreenError('invalid', 400, 'Screen request ID was reused with different content.');
    if (commit) {
      binding.requests.set(id, fingerprint);
      if (binding.requests.size > 64)
        binding.requests.delete(binding.requests.keys().next().value!);
    }
    return previous !== undefined;
  }
  private grant(link: Link, expires = link.expires): ScreenLinkGrant {
    const { profile, resolution, frameRate, videoBitrate } = link.share.value;
    return {
      link: {
        ...link.value,
        quality: {
          profile,
          videoBitrate,
          ...(resolution !== undefined && { resolution, frameRate }),
        },
        videoBitrate,
      },
      remainingMs: Math.max(0, Math.min(expires, link.expires) - this.now()),
    };
  }
  private checkRenewalCapacity(binding: Binding, additional: number) {
    if (binding.renewalPages || additional <= 0) return;
    const count = binding.selections.size + additional + (binding.share?.viewers.size ?? 0);
    if (count > SCREEN_RENEWAL_PAGE_SIZE)
      throw new ScreenError('capacity', 409, 'Update the screen client to renew more links.');
  }
  private dropLink(link: Link) {
    if (this.links.get(link.value.id) === link) {
      this.links.delete(link.value.id);
      link.share.viewers.delete(link);
      this.changed();
    }
    if (link.viewer.selections.get(link.share.value.id) === link)
      link.viewer.selections.delete(link.share.value.id);
  }
  private dropShare(share: Share) {
    if (this.shares.get(share.value.id) === share) {
      this.shares.delete(share.value.id);
      this.changed();
    }
    if (share.publisher.share === share) share.publisher.share = undefined;
    for (const link of share.viewers) this.dropLink(link);
  }
  private dropBinding(binding: Binding) {
    if (binding.share) this.dropShare(binding.share);
    for (const link of binding.selections.values()) this.dropLink(link);
    if (this.bindings.get(binding.userId) === binding) this.bindings.delete(binding.userId);
  }
  private clear() {
    for (const binding of this.bindings.values()) this.dropBinding(binding);
  }
  private prune() {
    for (const binding of this.bindings.values())
      if (!this.current(binding)) this.dropBinding(binding);
    for (const share of this.shares.values())
      if (share.expires <= this.now()) this.dropShare(share);
    for (const link of this.links.values()) if (link.expires <= this.now()) this.dropLink(link);
  }
  private checkLink(link: Link) {
    this.check(link.share.publisher);
    this.check(link.viewer);
    link.expires = Math.min(
      link.expires,
      link.viewer.lease.expires,
      link.share.publisher.lease.expires,
      link.share.expires,
    );
    if (
      this.links.get(link.value.id) !== link ||
      link.viewer.selections.get(link.share.value.id) !== link ||
      link.share.publisher.share !== link.share ||
      link.expires <= this.now()
    ) {
      this.dropLink(link);
      throw stale();
    }
  }
  bind(caller: ScreenCaller, value: unknown): Promise<ScreenBinding> {
    const body = input(value, ['version', 'leaseId', 'requestId']);
    const leaseId = uuid(body.leaseId),
      requestId = uuid(body.requestId);
    if (
      body.version !== SCREEN_PROTOCOL_VERSION ||
      !caller.transportId ||
      caller.transportId.length > 128
    )
      throw new ScreenError('invalid', 400, 'Unsupported screen protocol or transport.');
    return this.run(async () => {
      if (!caller.isConnected()) throw stale();
      const lease = await this.lease(caller.token, leaseId);
      if (!caller.isConnected()) throw stale();
      if (
        lease.revoked ||
        lease.expires <= this.now() ||
        this.voice.leases.get(lease.userId) !== lease
      )
        throw denied();
      let binding = this.bindings.get(lease.userId);
      if (binding && (binding.lease !== lease || binding.transportId !== caller.transportId))
        throw new ScreenError(
          'capacity',
          409,
          'Screen controls are already active on another connection.',
        );
      if (
        [...this.bindings.values()].some(
          (b) => b.transportId === caller.transportId && b.userId !== lease.userId,
        )
      )
        throw denied();
      if (!binding) {
        binding = {
          lease,
          leaseId,
          userId: lease.userId,
          sessionId: lease.sessionId,
          channelId: lease.channelId,
          transportId: caller.transportId,
          supportsMoreThanNineViewers: caller.supportsMoreThanNineViewers === true,
          renewalPages: caller.renewalPages === true,
          isConnected: caller.isConnected,
          requests: new Map(),
          selections: new Map(),
          epoch: randomUUID(),
          sourceGeneration: 0,
          selectionRevision: 0,
          renewalRevision: 0,
        };
        this.bindings.set(binding.userId, binding);
      }
      this.check(binding);
      this.request(binding, requestId, JSON.stringify(['bind', leaseId, body.version]), true);
      return {
        epoch: binding.epoch,
        channelId: binding.channelId,
        remainingMs: lease.expires - this.now(),
        ...this.relayConfig(binding),
      };
    });
  }
  publish(caller: ScreenCaller, value: unknown): Promise<ScreenPublishGrant> {
    const body = input(value, [
      'epoch',
      'requestId',
      'sourceGeneration',
      'profile',
      'videoBitrate',
      'resolution',
      'frameRate',
      'sound',
      'native',
    ]);
    const requestId = uuid(body.requestId),
      generation = revision(body.sourceGeneration),
      selected = quality(body);
    if (!['none', 'tab', 'system', 'application', 'source'].includes(body.sound as string))
      throw new ScreenError('invalid', 400, 'Invalid source sound mode.');
    if (body.native !== undefined && body.native !== true)
      throw new ScreenError('invalid', 400, 'Invalid native publication mode.');
    const native = body.native === true;
    const fingerprint = JSON.stringify([
      'publish',
      requestId,
      generation,
      selected,
      body.sound,
      native,
    ]);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      this.request(binding, requestId, fingerprint);
      if (
        generation === binding.sourceGeneration &&
        binding.lastPublish === fingerprint &&
        binding.share
      )
        return this.publication(binding.share, binding.share.publishExpires);
      if (generation <= binding.sourceGeneration) throw stale();
      if (binding.share)
        throw new ScreenError(
          'capacity',
          409,
          'Stop the current share before choosing another source.',
        );
      const share: Share = {
        expires: binding.lease.expires,
        publishExpires: binding.lease.expires,
        publisher: binding,
        native,
        viewers: new Set(),
        qualityRevision: 0,
        value: {
          id: randomUUID(),
          publisherId: binding.userId,
          sourceGeneration: generation,
          ...selected,
          sound: body.sound as ScreenShare['sound'],
        },
      };
      binding.share = share;
      binding.sourceGeneration = generation;
      binding.lastPublish = fingerprint;
      this.shares.set(share.value.id, share);
      this.changed();
      this.request(binding, requestId, fingerprint, true);
      return this.publication(share, share.publishExpires);
    });
  }
  stop(caller: ScreenCaller, value: unknown): Promise<{ stopped: true }> {
    const body = input(value, ['epoch', 'shareId']),
      shareId = uuid(body.shareId);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      if (binding.share && binding.share.value.id !== shareId) throw stale();
      if (binding.share) this.dropShare(binding.share);
      return { stopped: true };
    });
  }
  updateQuality(caller: ScreenCaller, value: unknown): Promise<ScreenShare> {
    const body = input(value, [
      'epoch',
      'shareId',
      'requestId',
      'revision',
      'profile',
      'videoBitrate',
      'resolution',
      'frameRate',
    ]);
    const shareId = uuid(body.shareId);
    const requestId = uuid(body.requestId);
    const next = revision(body.revision);
    const selected = quality(body);
    if (
      selected.profile === 'auto' ||
      selected.profile === 'ultra' ||
      selected.videoBitrate === null
    )
      throw new ScreenError('invalid', 400, 'Choose a supported stream format and bitrate.');
    const fingerprint = JSON.stringify(['quality', shareId, next, selected]);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      const share = binding.share;
      if (!share || share.value.id !== shareId) throw denied();
      const replay = this.request(binding, requestId, fingerprint);
      if (next < share.qualityRevision || (next === share.qualityRevision && !replay))
        throw stale();
      if (replay) return this.shareValue(share);
      this.request(binding, requestId, fingerprint, true);
      share.qualityRevision = next;
      if (!sameScreenQuality(share.value, selected)) {
        const { id, publisherId, sourceGeneration, sound } = share.value;
        share.value = { id, publisherId, sourceGeneration, sound, ...selected };
        this.changed();
      }
      return this.shareValue(share);
    });
  }
  select(
    caller: ScreenCaller,
    value: unknown,
    deliver?: (grant: ScreenLinkGrant | null) => void,
  ): Promise<ScreenLinkGrant | null> {
    const body = input(value, [
      'epoch',
      'requestId',
      'revision',
      'shareId',
      'profile',
      'videoBitrate',
      'resolution',
      'frameRate',
      'mode',
      'removeShareId',
    ]);
    const requestId = uuid(body.requestId),
      next = revision(body.revision);
    const legacyQuality = ['profile', 'videoBitrate', 'resolution', 'frameRate'].some((field) =>
      Object.hasOwn(body, field),
    )
      ? quality(body)
      : null;
    const shareId = body.shareId === null ? null : uuid(body.shareId);
    const mode = body.mode === undefined ? (shareId === null ? 'clear' : 'replace') : body.mode;
    if (!['replace', 'add', 'remove', 'clear'].includes(mode as string))
      throw new ScreenError('invalid', 400, 'Invalid screen selection mode.');
    const removeShareId = body.removeShareId === undefined ? null : uuid(body.removeShareId);
    if (
      ((mode === 'replace' || mode === 'add') && !shareId) ||
      ((mode === 'remove' || mode === 'clear') && shareId !== null) ||
      (mode === 'remove' && !removeShareId) ||
      (mode !== 'remove' && removeShareId !== null)
    )
      throw new ScreenError('invalid', 400, 'Invalid screen selection mode.');
    const fingerprint = JSON.stringify([
      'select',
      requestId,
      next,
      shareId,
      legacyQuality,
      mode,
      removeShareId,
    ]);
    return this.run(async () => {
      const finish = (grant: ScreenLinkGrant | null) => {
        deliver?.(grant);
        return grant;
      };
      const viewer = await this.bound(caller, body.epoch);
      this.request(viewer, requestId, fingerprint);
      if (
        next < viewer.selectionRevision ||
        (next === viewer.selectionRevision && viewer.lastSelection !== fingerprint)
      )
        throw stale();
      if (next === viewer.selectionRevision) {
        if (mode === 'remove' || mode === 'clear') return finish(null);
        if (!shareId) throw stale();
        const link = viewer.selections.get(shareId);
        if (!link) throw stale();
        await this.pair(viewer, link.share.publisher);
        this.checkLink(link);
        return finish(this.grant(link));
      }
      if (mode === 'remove') {
        const old = viewer.selections.get(removeShareId!);
        if (old) this.dropLink(old);
        viewer.selectionRevision = next;
        viewer.lastSelection = fingerprint;
        this.request(viewer, requestId, fingerprint, true);
        return finish(null);
      }
      if (mode === 'clear') {
        for (const old of viewer.selections.values()) this.dropLink(old);
        viewer.selectionRevision = next;
        viewer.lastSelection = fingerprint;
        this.request(viewer, requestId, fingerprint, true);
        return finish(null);
      }
      const share = shareId ? this.shares.get(shareId) : undefined;
      if (
        shareId &&
        (!share || share.publisher === viewer || share.publisher.channelId !== viewer.channelId)
      )
        throw denied();
      if (share) {
        await this.pair(viewer, share.publisher);
        if (share.publisher.share !== share) throw stale();
        if (!viewer.selections.has(share.value.id)) {
          // The old native helper accepts three peers and rejects larger authorization snapshots.
          if (
            share.native &&
            share.viewers.size >= (share.nativeViewerBatch ? NATIVE_VIEWER_GRANT_BATCH_SIZE : 3)
          )
            throw new ScreenError(
              'capacity',
              409,
              share.nativeViewerBatch
                ? 'This publisher has filled its native viewer authorization batch.'
                : 'Update the publisher’s Rajcord Desktop to share with more viewers.',
            );
          if (!share.publisher.supportsMoreThanNineViewers && share.viewers.size >= 9)
            throw new ScreenError(
              'capacity',
              409,
              'This publisher can share with up to 9 viewers.',
            );
          this.checkRenewalCapacity(share.publisher, 1);
          this.checkRenewalCapacity(viewer, mode === 'replace' ? 1 - viewer.selections.size : 1);
        }
      }
      if (mode === 'replace') for (const old of viewer.selections.values()) this.dropLink(old);
      const existing = viewer.selections.get(shareId!);
      if (existing) this.dropLink(existing);
      viewer.selectionRevision = next;
      viewer.lastSelection = fingerprint;
      this.request(viewer, requestId, fingerprint, true);
      if (!share) return finish(null);
      const link: Link = {
        share,
        viewer,
        expires: Math.min(viewer.lease.expires, share.publisher.lease.expires, share.expires),
        value: {
          id: randomUUID(),
          shareId: share.value.id,
          publisherId: share.publisher.userId,
          viewerId: viewer.userId,
          selectionRevision: next,
        },
      };
      viewer.selections.set(share.value.id, link);
      share.viewers.add(link);
      this.links.set(link.value.id, link);
      this.changed();
      return finish(this.grant(link));
    });
  }
  authorizeLink(caller: ScreenCaller, value: unknown): Promise<ScreenLinkGrant> {
    const body = input(value, ['epoch', 'linkId']),
      linkId = uuid(body.linkId);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch),
        link = this.links.get(linkId);
      if (!link || (link.viewer !== binding && link.share.publisher !== binding)) throw denied();
      await this.pair(binding, link.viewer === binding ? link.share.publisher : link.viewer);
      this.checkLink(link);
      return this.grant(link);
    });
  }
  // Delivery callbacks run synchronously after the final fences, while holding the voice lock.
  // A returned DTO alone never authorizes a subsequent private delivery.
  snapshot(
    caller: ScreenCaller,
    value: unknown,
    deliver: (snapshot: ScreenSnapshot) => void,
  ): Promise<ScreenDirectory>;
  snapshot(
    caller: ScreenCaller,
    value: unknown,
    deliver: (snapshot: ScreenSnapshot) => void,
    knownRevision: number,
    known?: SnapshotMembership,
  ): Promise<number | null>;
  async snapshot(
    caller: ScreenCaller,
    value: unknown,
    deliver: (snapshot: ScreenSnapshot) => void,
    knownRevision?: number,
    known?: SnapshotMembership,
  ) {
    const body = input(value, ['epoch']);
    // A poll that cannot deliver data need not wait behind voice mutations.
    // If the revision changes during authorization, the next poll will send it.
    if (knownRevision === this.stateRevision) {
      await this.bound(caller, body.epoch);
      return knownRevision;
    }
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      // Unchanged polls authorize the recipient but deliver nothing. A changed
      // snapshot still freshly authorizes every source and link below.
      if (knownRevision === this.stateRevision) return knownRevision;
      let shares = [...this.shares.values()].filter(
        (s) => s.publisher.channelId === binding.channelId,
      );
      if (!caller.directoryChanges && shares.length > 10) {
        // Released clients reject an entire directory with more than ten entries.
        // Keep active watches and the caller's publication, then fill in publication order.
        const active = (share: Share) =>
          binding.share === share || binding.selections.has(share.value.id);
        shares = [...shares.filter(active), ...shares.filter((share) => !active(share))].slice(
          0,
          10,
        );
      }
      const links = [...this.links.values()].filter(
        (l) => l.viewer === binding || l.share.publisher === binding,
      );
      // Changes to other viewers' selections do not require delivering this same snapshot.
      if (
        known &&
        shares.length === known.shares.size &&
        links.length === known.links.size &&
        shares.every(({ value }) => {
          const previous = known.shares.get(value.id);
          return previous && sameScreenQuality(value, previous);
        }) &&
        links.every((link) => known.links.has(link.value.id))
      )
        return this.stateRevision;
      const peers = new Set(shares.map((s) => s.publisher));
      for (const link of links) {
        peers.add(link.viewer);
        peers.add(link.share.publisher);
      }
      peers.delete(binding);
      const droppedPeer = await this.endpoints(binding, peers, knownRevision !== undefined);
      // A refresh can rebuild its directory after pruning, including any legacy entries
      // that move into view. Leave the transport's delivered revision unchanged.
      if (droppedPeer) return null;
      this.check(binding);
      for (const peer of peers) this.check(peer);
      for (const share of shares) if (share.publisher.share !== share) throw stale();
      for (const link of links) this.checkLink(link);
      const snapshot: ScreenSnapshot = {
        directory: {
          epoch: binding.epoch,
          revision: this.stateRevision,
          shares: shares.map((s) => this.shareValue(s)),
        },
        links: links.map((l) => this.grant(l)),
      };
      deliver(snapshot);
      // The transport records delivery only after every packet fits its output budget.
      return knownRevision === undefined ? snapshot.directory : null;
    });
  }
  relay(
    caller: ScreenCaller,
    value: unknown,
    deliver: (destination: ScreenDestination, notice: ScreenSignalNotice) => boolean,
  ) {
    const request = signal(value);
    return this.run(async () => {
      const binding = this.findBinding(caller, request.epoch),
        link = this.links.get(request.linkId);
      if (caller.token !== binding.lease.token) throw denied();
      if (!link || (link.viewer !== binding && link.share.publisher !== binding)) throw denied();
      const publisher = binding === link.share.publisher;
      const peer = publisher ? link.viewer : link.share.publisher;
      await this.pair(binding, peer);
      this.checkLink(link);
      const side = publisher ? 0 : 1,
        payload = request.payload;
      const sequences = link.sequences ?? [0, 0];
      if (request.sequence <= sequences[side]) throw stale();
      let negotiation = link.negotiation;
      if (payload.type === 'offer') {
        if (
          !publisher ||
          request.revision !== (negotiation?.revision ?? 0) + 1 ||
          (negotiation && !negotiation.answer && negotiation.deadline > this.now())
        )
          throw stale();
        const offer = description(payload.sdp, 'offer');
        if (
          offer.mids.length !== (link.share.value.sound === 'none' ? 1 : 2) ||
          offer.candidates > 32
        )
          throw new ScreenError('invalid', 400, 'Unexpected source media or early ICE count.');
        negotiation = {
          revision: request.revision,
          offer,
          deadline: this.now() + 10000,
          early: offer.candidates,
          candidates: [offer.candidates, 0],
        };
      } else {
        if (
          !negotiation ||
          request.revision !== negotiation.revision ||
          (!negotiation.answer && negotiation.deadline <= this.now())
        )
          throw stale();
        negotiation = { ...negotiation, candidates: [...negotiation.candidates] };
        if (payload.type === 'answer') {
          if (publisher || negotiation.answer) throw stale();
          const answer = description(payload.sdp, 'answer');
          if (
            answer.mids.join() !== negotiation.offer.mids.join() ||
            answer.kinds.join() !== negotiation.offer.kinds.join()
          )
            throw stale();
          negotiation.answer = answer;
          negotiation.answerHash = createHash('sha256').update(payload.sdp).digest('hex');
          negotiation.candidates[1] = answer.candidates;
        } else {
          const desc = publisher ? negotiation.offer : negotiation.answer;
          const c = payload.candidate;
          if (
            !desc ||
            desc.mids[c.sdpMLineIndex] !== c.sdpMid ||
            desc.ufrags[c.sdpMLineIndex] !== c.usernameFragment ||
            ++negotiation.candidates[side] > 128 ||
            (!negotiation.answer && ++negotiation.early > 32)
          )
            throw stale();
        }
      }
      if (
        !deliver(
          { transportId: peer.transportId, epoch: peer.epoch },
          { ...request, epoch: peer.epoch },
        )
      )
        throw stale();
      sequences[side] = request.sequence;
      link.sequences = sequences;
      link.negotiation = negotiation;
      return { delivered: true as const };
    });
  }
  renew(
    caller: ScreenCaller,
    value: unknown,
    deliver?: (
      renewal: ScreenRenewal,
      legacy?: { revision: number; outgoing: ReadonlySet<string> },
    ) => void,
  ): Promise<ScreenRenewal> {
    const body = input(value, ['epoch', 'requestId', 'revision', 'offset']);
    const offset = body.offset === undefined ? 0 : revision(body.offset);
    if (offset % SCREEN_RENEWAL_PAGE_SIZE !== 0)
      throw new ScreenError('invalid', 400, 'Invalid screen renewal offset.');
    const requestId = uuid(body.requestId),
      next = revision(body.revision),
      fingerprint = JSON.stringify(['renew', requestId, next]);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      this.request(binding, requestId, fingerprint);
      if (
        next < binding.renewalRevision ||
        (next === binding.renewalRevision && binding.lastRenewal !== fingerprint)
      )
        throw stale();
      const replay = next === binding.renewalRevision;
      if (offset && (!binding.renewalPages || !replay || offset >= binding.renewal!.links.length))
        throw stale();
      const end = binding.renewalPages ? offset + SCREEN_RENEWAL_PAGE_SIZE : undefined;
      const own = replay ? binding.renewal!.publication?.share : binding.share;
      const requestedLinks = replay
        ? binding.renewal!.links.slice(offset, end).map((item) => item.link)
        : [...this.links.values()].filter(
            (link) => link.viewer === binding || link.share.publisher === binding,
          );
      const droppedPeer = await this.endpoints(
        binding,
        new Set(
          requestedLinks.map((link) =>
            link.viewer === binding ? link.share.publisher : link.viewer,
          ),
        ),
        true,
      );
      // Replayed pages must keep their original offsets. Only a fresh renewal
      // can drop revoked links and build a new set of pages.
      if (droppedPeer && replay) throw stale();
      const links = droppedPeer
        ? requestedLinks.filter((link) => this.links.get(link.value.id) === link)
        : requestedLinks;
      this.check(binding);
      if (
        own &&
        (binding.share !== own ||
          this.shares.get(own.value.id) !== own ||
          own.expires <= this.now())
      )
        throw stale();
      for (const link of links) this.checkLink(link);
      if (!replay) {
        if (own) own.expires = binding.lease.expires;
        for (const link of links)
          link.expires = Math.min(
            link.viewer.lease.expires,
            link.share.publisher.lease.expires,
            link.share.expires,
          );
        binding.renewal = {
          expires: binding.lease.expires,
          links: links.map((link) => ({ link, expires: link.expires })),
          publication: own ? { share: own, expires: own.expires } : null,
        };
        binding.renewalRevision = next;
        binding.lastRenewal = fingerprint;
        this.request(binding, requestId, fingerprint, true);
      }
      const result: ScreenRenewal = {
        ...this.relayConfig(binding),
        remainingMs: Math.max(
          0,
          Math.min(binding.renewal!.expires, binding.lease.expires) - this.now(),
        ),
        ...(end !== undefined && end < binding.renewal!.links.length ? { nextOffset: end } : {}),
        links: binding
          .renewal!.links.slice(offset, end)
          .map((item) => this.grant(item.link, item.expires)),
        publication: binding.renewal!.publication
          ? this.publication(
              binding.renewal!.publication.share,
              binding.renewal!.publication.expires,
            )
          : null,
      };
      if (deliver && !binding.supportsMoreThanNineViewers) {
        const outgoing = new Set<string>();
        for (const { link } of binding.renewal!.links)
          if (link.share.publisher === binding && this.links.get(link.value.id) === link)
            outgoing.add(link.value.id);
        deliver(result, { revision: this.stateRevision, outgoing });
      } else deliver?.(result);
      return result;
    });
  }
  disconnect(transportId: string, epoch: string) {
    const binding = [...this.bindings.values()].find(
      (b) => b.transportId === transportId && b.epoch === epoch,
    );
    if (binding) this.dropBinding(binding);
  }
  sweep() {
    this.prune();
  }
  dispose() {
    this.disposed = true;
    this.clear();
    this.unsubscribe();
  }
}
