import { randomUUID } from 'node:crypto';
import {
  SCREEN_PROTOCOL_VERSION,
  SCREEN_PROFILES,
  SCREEN_VIDEO_BITRATES,
  type ScreenBinding,
  type ScreenErrorCode,
  type ScreenQuality,
  type ScreenShare,
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

// Supplied by the authenticated server transport, never accepted from a client payload.
export type ScreenCaller = { token: string; transportId: string; isConnected: () => boolean };
type Voice = Pick<VoiceService, 'leases' | 'authorize' | 'exclusive' | 'onLeaseInvalidated'>;
type Binding = {
  lease: Lease;
  leaseId: string;
  userId: string;
  sessionId: string;
  channelId: string;
  transportId: string;
  epoch: string;
  sourceGeneration: number;
  selectionRevision: number;
  isConnected: () => boolean;
  requests: Map<string, string>;
  renewalRevision: number;
  share?: Share;
  selection?: Link;
  lastPublish?: string;
  lastSelection?: string;
  lastRenewal?: string;
  renewal?: { expires: number; links: { link: Link; expires: number }[] };
};
type Share = { value: ScreenShare; publisher: Binding };
type Link = {
  value: ScreenLink;
  share: Share;
  viewer: Binding;
  expires: number;
  negotiation?: {
    revision: number;
    offer: Description;
    answer?: Description;
    deadline: number;
    early: number;
    candidates: [number, number];
  };
  sequences?: [number, number];
};
export type ScreenSnapshot = { directory: ScreenDirectory; links: ScreenLinkGrant[] };
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
  if (
    !(SCREEN_PROFILES as readonly unknown[]).includes(body.profile) ||
    (body.videoBitrate !== null &&
      !(SCREEN_VIDEO_BITRATES as readonly unknown[]).includes(body.videoBitrate))
  )
    throw new ScreenError('invalid', 400, 'Invalid screen quality or video bitrate.');
  return {
    profile: body.profile as ScreenQuality['profile'],
    videoBitrate: body.videoBitrate as ScreenVideoBitrate,
  };
}

export class ScreenService {
  private bindings = new Map<string, Binding>();
  private shares = new Map<string, Share>();
  private links = new Map<string, Link>();
  private disposed = false;
  private unsubscribe: () => void;
  private stateRevision = 1;
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
  private async bound(caller: ScreenCaller, epoch: unknown) {
    if (!caller.isConnected()) throw stale();
    const id = uuid(epoch);
    const binding = [...this.bindings.values()].find(
      (b) => b.transportId === caller.transportId && b.epoch === id,
    );
    if (!binding) throw stale();
    const lease = await this.lease(caller.token, binding.leaseId, binding);
    this.check(binding);
    if (lease !== binding.lease) throw stale();
    return binding;
  }
  private async pair(caller: Binding, peer: Binding) {
    const lease = await this.lease(peer.lease.token, peer.leaseId, peer);
    await this.lease(caller.lease.token, caller.leaseId, caller);
    this.check(caller);
    this.check(peer);
    if (lease !== peer.lease || caller.channelId !== peer.channelId) throw denied();
  }
  private shareValue(share: Share): ScreenShare {
    return { ...share.value };
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
  }
  private grant(link: Link, expires = link.expires): ScreenLinkGrant {
    return {
      link: { ...link.value, quality: { ...link.value.quality } },
      remainingMs: Math.max(0, Math.min(expires, link.expires) - this.now()),
    };
  }
  private dropLink(link: Link) {
    if (this.links.get(link.value.id) === link) {
      this.links.delete(link.value.id);
      this.changed();
    }
    if (link.viewer.selection === link) link.viewer.selection = undefined;
  }
  private dropShare(share: Share) {
    if (this.shares.get(share.value.id) === share) {
      this.shares.delete(share.value.id);
      this.changed();
    }
    if (share.publisher.share === share) share.publisher.share = undefined;
    for (const link of this.links.values()) if (link.share === share) this.dropLink(link);
  }
  private dropBinding(binding: Binding) {
    if (binding.share) this.dropShare(binding.share);
    if (binding.selection) this.dropLink(binding.selection);
    if (this.bindings.get(binding.userId) === binding) this.bindings.delete(binding.userId);
  }
  private clear() {
    for (const binding of this.bindings.values()) this.dropBinding(binding);
  }
  private prune() {
    for (const binding of this.bindings.values())
      if (!this.current(binding)) this.dropBinding(binding);
    for (const link of this.links.values()) if (link.expires <= this.now()) this.dropLink(link);
  }
  private checkLink(link: Link) {
    this.check(link.share.publisher);
    this.check(link.viewer);
    link.expires = Math.min(
      link.expires,
      link.viewer.lease.expires,
      link.share.publisher.lease.expires,
    );
    if (
      this.links.get(link.value.id) !== link ||
      link.viewer.selection !== link ||
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
          isConnected: caller.isConnected,
          requests: new Map(),
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
      };
    });
  }
  publish(caller: ScreenCaller, value: unknown): Promise<ScreenShare> {
    const body = input(value, [
      'epoch',
      'requestId',
      'sourceGeneration',
      'profile',
      'videoBitrate',
      'sound',
    ]);
    const requestId = uuid(body.requestId),
      generation = revision(body.sourceGeneration),
      selected = quality(body);
    if (!['none', 'tab', 'system'].includes(body.sound as string))
      throw new ScreenError('invalid', 400, 'Invalid source sound mode.');
    const fingerprint = JSON.stringify(['publish', requestId, generation, selected, body.sound]);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      this.request(binding, requestId, fingerprint);
      if (
        generation === binding.sourceGeneration &&
        binding.lastPublish === fingerprint &&
        binding.share
      )
        return this.shareValue(binding.share);
      if (generation <= binding.sourceGeneration) throw stale();
      if (binding.share)
        throw new ScreenError(
          'capacity',
          409,
          'Stop the current share before choosing another source.',
        );
      const share: Share = {
        publisher: binding,
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
      return this.shareValue(share);
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
    ]);
    const requestId = uuid(body.requestId),
      next = revision(body.revision),
      selected = quality(body);
    const shareId = body.shareId === null ? null : uuid(body.shareId);
    const fingerprint = JSON.stringify(['select', requestId, next, shareId, selected]);
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
        if (shareId === null) return finish(null);
        if (!viewer.selection) throw stale();
        const link = viewer.selection;
        await this.pair(viewer, link.share.publisher);
        this.checkLink(link);
        return finish(this.grant(link));
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
        if (
          SCREEN_PROFILES.indexOf(selected.profile) > SCREEN_PROFILES.indexOf(share.value.profile)
        )
          throw new ScreenError('invalid', 400, 'Requested quality exceeds the publisher ceiling.');
      }
      if (viewer.selection) this.dropLink(viewer.selection);
      viewer.selectionRevision = next;
      viewer.lastSelection = fingerprint;
      this.request(viewer, requestId, fingerprint, true);
      if (!share) return finish(null);
      const caps = [share.value.videoBitrate, selected.videoBitrate].filter(
        (cap): cap is Exclude<ScreenVideoBitrate, null> => cap !== null,
      );
      const link: Link = {
        share,
        viewer,
        expires: Math.min(viewer.lease.expires, share.publisher.lease.expires),
        value: {
          id: randomUUID(),
          shareId: share.value.id,
          publisherId: share.publisher.userId,
          viewerId: viewer.userId,
          selectionRevision: next,
          quality: selected,
          videoBitrate: caps.length ? (Math.min(...caps) as ScreenVideoBitrate) : null,
        },
      };
      viewer.selection = link;
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
  snapshot(caller: ScreenCaller, value: unknown, deliver: (snapshot: ScreenSnapshot) => void) {
    const body = input(value, ['epoch']);
    return this.run(async () => {
      const binding = await this.bound(caller, body.epoch);
      const shares = [...this.shares.values()].filter(
        (s) => s.publisher.channelId === binding.channelId,
      );
      const links = [...this.links.values()].filter(
        (l) => l.viewer === binding || l.share.publisher === binding,
      );
      const peers = new Set(shares.map((s) => s.publisher));
      for (const link of links) {
        peers.add(link.viewer);
        peers.add(link.share.publisher);
      }
      peers.delete(binding);
      for (const peer of peers) await this.pair(binding, peer);
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
      return snapshot.directory;
    });
  }
  relay(
    caller: ScreenCaller,
    value: unknown,
    deliver: (destination: ScreenDestination, notice: ScreenSignalNotice) => boolean,
  ) {
    const request = signal(value);
    return this.run(async () => {
      const binding = await this.bound(caller, request.epoch),
        link = this.links.get(request.linkId);
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
    deliver?: (renewal: ScreenRenewal) => void,
  ): Promise<ScreenRenewal> {
    const body = input(value, ['epoch', 'requestId', 'revision']);
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
      const links = replay
        ? binding.renewal!.links.map((item) => item.link)
        : [...this.links.values()].filter(
            (link) => link.viewer === binding || link.share.publisher === binding,
          );
      for (const link of links) {
        await this.pair(binding, link.viewer === binding ? link.share.publisher : link.viewer);
        this.checkLink(link);
      }
      this.check(binding);
      for (const link of links) this.checkLink(link);
      if (!replay) {
        for (const link of links)
          link.expires = Math.min(link.viewer.lease.expires, link.share.publisher.lease.expires);
        binding.renewal = {
          expires: binding.lease.expires,
          links: links.map((link) => ({ link, expires: link.expires })),
        };
        binding.renewalRevision = next;
        binding.lastRenewal = fingerprint;
        this.request(binding, requestId, fingerprint, true);
        this.changed();
      }
      const result: ScreenRenewal = {
        remainingMs: Math.max(
          0,
          Math.min(binding.renewal!.expires, binding.lease.expires) - this.now(),
        ),
        links: binding.renewal!.links.map((item) => this.grant(item.link, item.expires)),
      };
      deliver?.(result);
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
