import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { approved, identity } from '../auth/service.js';
import { HttpError, input, text, uuid } from '../auth/validation.js';
import type { VoiceConfig } from './config.js';
export type Lease = {
  id: string;
  userId: string;
  sessionId: string;
  token: string;
  name: string;
  channelId: string;
  room: string;
  expires: number;
  revoked: boolean;
  close?: () => void;
};
export class VoiceService {
  readonly media: RoomServiceClient;
  readonly leases = new Map<string, Lease>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  readonly prefix: string;
  constructor(
    readonly pool: Pool,
    readonly config: VoiceConfig,
  ) {
    this.media = new RoomServiceClient(config.url, config.key, config.secret, {
      requestTimeout: 5,
    });
    this.prefix = config.prefix ?? 'tricord-voice-';
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work);
    this.queue = task.catch(() => {});
    return task;
  }
  async initialize() {
    if (this.initialized) return;
    for (const room of await this.media.listRooms())
      if (room.name.startsWith(this.prefix)) await this.media.deleteRoom(room.name);
    this.initialized = true;
  }
  async channels(token: string) {
    approved(await identity(this.pool, token));
    const { rows } = await this.pool.query(
      'SELECT id,name FROM voice_channels ORDER BY created_at,id',
    );
    return rows.map((row) => ({
      ...row,
      participants: [...this.leases.values()]
        .filter((l) => !l.revoked && l.channelId === row.id)
        .map((l) => ({ id: l.userId, name: l.name })),
    }));
  }
  async create(token: string, value: unknown) {
    approved(await identity(this.pool, token));
    const body = input(value, ['name']);
    const name = text(body.name, 1, 48, 'channel name');
    const result = await this.pool.query(
      'INSERT INTO voice_channels(name) VALUES($1) ON CONFLICT DO NOTHING RETURNING id,name',
      [name],
    );
    if (!result.rowCount) throw new HttpError(409, 'A voice channel already has that name.');
    return result.rows[0];
  }
  async join(token: string, value: unknown) {
    const body = input(value, ['channelId', 'leaseId']);
    const channelId = uuid(body.channelId);
    return this.exclusive(async () => {
      const auth = approved(await identity(this.pool, token));
      await this.initialize();
      await this.reconcileUnlocked();
      const found = this.leases.get(auth.user.id);
      if (found) {
        if (
          !found.revoked &&
          found.id === body.leaseId &&
          found.sessionId === auth.sessionId &&
          found.channelId === channelId
        ) {
          found.expires = Date.now() + 45000;
          return this.publicLease(found);
        }
        throw new HttpError(
          409,
          'This account is already in voice. Leave that session before joining here.',
        );
      }
      if (
        !(await this.pool.query('SELECT id FROM voice_channels WHERE id=$1', [channelId])).rowCount
      )
        throw new HttpError(404, 'Voice channel not found.');
      if (
        [...this.leases.values()].filter((l) => !l.revoked && l.channelId === channelId).length >=
        10
      )
        throw new HttpError(409, 'This voice channel is full (10 people).');
      const room = this.prefix + channelId;
      await this.media.createRoom({
        name: room,
        maxParticipants: 10,
        emptyTimeout: 60,
        departureTimeout: 30,
      });
      // Recheck after the media service call; suspension may have committed in the meantime.
      const fresh = approved(await identity(this.pool, token));
      const lease: Lease = {
        id: randomUUID(),
        userId: fresh.user.id,
        sessionId: fresh.sessionId,
        token,
        name: fresh.user.displayName,
        channelId,
        room,
        expires: Date.now() + 45000,
        revoked: false,
      };
      this.leases.set(lease.userId, lease);
      return this.publicLease(lease);
    });
  }
  publicLease(lease: Lease) {
    return { id: lease.id, channelId: lease.channelId, credential: lease.id };
  }
  async authorize(token: string, credential: string) {
    const auth = approved(await identity(this.pool, token));
    const lease = this.leases.get(auth.user.id);
    if (
      !lease ||
      lease.revoked ||
      lease.id !== credential ||
      lease.sessionId !== auth.sessionId ||
      lease.expires < Date.now()
    )
      throw new HttpError(401, 'Voice session ended.');
    return lease;
  }
  async heartbeat(token: string, value: unknown) {
    const body = input(value, ['leaseId']);
    return this.exclusive(async () => {
      const auth = approved(await identity(this.pool, token));
      const current = this.leases.get(auth.user.id);
      if (!current || current.expires < Date.now())
        throw new HttpError(410, 'Voice reservation expired; rejoin with a current session.');
      if (current.id !== body.leaseId || current.sessionId !== auth.sessionId)
        throw new HttpError(409, 'Voice is active on another device.');
      const lease = await this.authorize(token, uuid(body.leaseId));
      lease.expires = Date.now() + 45000;
      return { ok: true };
    });
  }
  async leave(token: string, value: unknown) {
    const body = input(value, ['leaseId']);
    const auth = approved(await identity(this.pool, token));
    return this.exclusive(async () => {
      const lease = this.leases.get(auth.user.id);
      if (lease && lease.id === uuid(body.leaseId) && lease.sessionId === auth.sessionId)
        await this.remove(lease);
      return { ok: true };
    });
  }
  async remove(lease: Lease) {
    lease.revoked = true;
    lease.close?.();
    try {
      await this.media.removeParticipant(lease.room, lease.userId);
    } catch (error) {
      if (!['not_found', 'NOT_FOUND'].includes(String((error as { code?: string }).code)))
        throw error;
    }
    if (this.leases.get(lease.userId) === lease) this.leases.delete(lease.userId);
  }
  async reconcileUnlocked() {
    for (const lease of this.leases.values()) {
      if (lease.revoked || lease.expires < Date.now()) {
        await this.remove(lease);
        continue;
      }
      const auth = await identity(this.pool, lease.token);
      if (
        lease.revoked ||
        lease.expires < Date.now() ||
        !auth ||
        auth.user.status !== 'approved' ||
        auth.sessionId !== lease.sessionId
      )
        await this.remove(lease);
    }
  }
  async reconcile() {
    return this.exclusive(() => this.reconcileUnlocked());
  }
  async jwt(lease: Lease) {
    const token = new AccessToken(this.config.key, this.config.secret, {
      identity: lease.userId,
      name: lease.name,
      ttl: 60,
    });
    token.addGrant({
      roomJoin: true,
      room: lease.room,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }
  async close() {
    await this.exclusive(async () => {
      for (const lease of [...this.leases.values()]) {
        try {
          await this.remove(lease);
        } catch {
          lease.close?.();
        }
      }
    });
  }
}
