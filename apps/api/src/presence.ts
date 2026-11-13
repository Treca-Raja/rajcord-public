import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import {
  PRESENCE_TIMING,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type PresenceSnapshot,
} from '@tricord/shared';
import { identity } from './auth/service.js';

type PresenceSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Single-process, ephemeral presence. All synchronization and deliveries share one queue. */
export class PresenceService {
  private epoch = randomUUID();
  private revision = 0;
  private online = new Set<string>();
  private roster = '';
  private healthy = true;
  private closed = false;
  private queue = Promise.resolve();
  private grace = new Map<string, { userId: string; token: string; deadline: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private periodic: ReturnType<typeof setInterval>;

  constructor(
    private pool: Pool,
    private io: Server<ClientToServerEvents, ServerToClientEvents>,
  ) {
    io.on('connection', (socket) => this.connected(socket));
    this.periodic = setInterval(() => void this.reconcile(), PRESENCE_TIMING.authorizationCheckMs);
    this.periodic.unref();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private connected(socket: PresenceSocket) {
    let requests = 0;
    let disconnected = false;
    let windowStart = Date.now();
    socket.on('presence:snapshot', (ack) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - windowStart >= 60000) {
        windowStart = Date.now();
        requests = 0;
      }
      // Independent, narrow synchronization budget; no per-view/per-member requests needed.
      if (++requests > 12) {
        ack({ ok: false, status: 429, error: 'Too many presence requests. Try again later.' });
        return;
      }
      void this.serial(async () => {
        if (this.closed || !socket.connected) return;
        try {
          await this.synchronize();
          const auth = await identity(this.pool, socket.data.token);
          if (!auth || auth.user.status !== 'approved') {
            ack({ ok: false, status: 403, error: 'An approved account is required.' });
            return;
          }
          const data: PresenceSnapshot = {
            epoch: this.epoch,
            revision: this.revision,
            onlineIds: [...this.online].sort(),
          };
          if (socket.connected) ack({ ok: true, data });
        } catch {
          this.unavailable();
          ack({ ok: false, status: 503, error: 'Presence temporarily unavailable.' });
        }
      });
    });
    socket.on('disconnect', (reason) => {
      if (disconnected) return;
      disconnected = true;
      const auth = socket.data.auth;
      if (auth?.user.status === 'approved') {
        if (reason === 'server namespace disconnect' || reason === 'server shutting down')
          this.grace.delete(socket.id);
        else if (!this.grace.has(socket.id))
          this.grace.set(socket.id, {
            userId: auth.user.id,
            token: socket.data.token,
            deadline: Date.now() + PRESENCE_TIMING.reconnectGraceMs,
          });
      }
      void this.reconcile();
    });
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      try {
        await this.synchronize();
      } catch {
        this.unavailable();
      }
    });
  }

  private unavailable() {
    if (!this.healthy || this.closed) return;
    this.healthy = false;
    // No identity, roster or previous status is included in an uncertainty signal.
    for (const socket of this.io.sockets.sockets.values()) socket.emit('presence:unavailable');
  }

  private async synchronize() {
    const next = new Set<string>();
    // Revalidate every connection and every recipient. Socket rooms are never grants.
    for (const socket of this.io.sockets.sockets.values()) {
      const auth = await identity(this.pool, socket.data.token);
      if (!auth || auth.user.status !== 'approved') {
        this.grace.delete(socket.id);
        if (!auth) socket.disconnect(true);
        continue;
      }
      if (!socket.connected) continue;
      socket.data.auth = auth;
      next.add(auth.user.id);
    }
    for (const [id, entry] of this.grace) {
      const auth = await identity(this.pool, entry.token);
      if (!auth || auth.user.status !== 'approved' || entry.deadline <= Date.now())
        this.grace.delete(id);
      else next.add(entry.userId);
    }
    const { rows } = await this.pool.query<{ id: string; username: string; display_name: string }>(
      "SELECT u.id,u.username,u.display_name,EXISTS(SELECT 1 FROM platform WHERE owner_id=u.id) is_owner FROM users u WHERE status='approved' ORDER BY u.id",
    );
    const eligible = new Set(rows.map((row) => row.id));
    for (const id of next) if (!eligible.has(id)) next.delete(id);
    const roster = JSON.stringify(rows);
    const recovering = !this.healthy;
    if (recovering) {
      this.epoch = randomUUID();
      this.revision = 0;
    }
    const changes = [
      ...[...next].filter((id) => !this.online.has(id)).map((userId) => ({ userId, online: true })),
      ...[...this.online]
        .filter((id) => !next.has(id))
        .map((userId) => ({ userId, online: false })),
    ];
    const rosterChanged = roster !== this.roster || recovering;
    this.online = next;
    this.roster = roster;
    this.healthy = true;
    if (changes.length || rosterChanged) {
      const delta = { epoch: this.epoch, revision: ++this.revision, changes, rosterChanged };
      for (const socket of this.io.sockets.sockets.values()) {
        const auth = await identity(this.pool, socket.data.token);
        if (socket.connected && auth?.user.status === 'approved')
          socket.emit('presence:changed', delta);
        else if (!auth) socket.disconnect(true);
      }
    }
    clearTimeout(this.timer);
    const deadlines = [...this.grace.values()].map((entry) => entry.deadline);
    if (deadlines.length) {
      this.timer = setTimeout(
        () => void this.reconcile(),
        Math.max(0, Math.min(...deadlines) - Date.now()),
      );
      this.timer.unref();
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.periodic);
    clearTimeout(this.timer);
    this.grace.clear();
    this.online.clear();
    return this.queue;
  }
}
