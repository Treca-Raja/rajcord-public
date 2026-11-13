import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService } from '../auth/service.js';
import { createApp } from '../app.js';
import { testDatabase } from '../db/test-database.js';
import { checkVoiceTestServices } from '../voice/test-services.js';

const origin = 'http://127.0.0.1:3006';
const config = await checkVoiceTestServices();
const database = await testDatabase();
let cleanup: () => Promise<void> = async () => {};
try {
  const auth = new AuthService(database.database.pool);
  const password = randomUUID() + '-Fixture';
  const owner = await auth.bootstrap('authority_owner', 'Fixture owner', password);
  const ownerLogin = await auth.login(
    { username: owner.username, password, remember: false },
    undefined,
  );
  const prefix = 'tricord-authority-native-' + randomUUID() + '-';
  const ownedRoot = fileURLToPath(new URL('../../../../.local/', import.meta.url));
  await mkdir(ownedRoot, { recursive: true });
  const profile = await mkdtemp(path.join(ownedRoot, 'screen-authority-smoke-'));
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(ownedRoot));
  assert.match(path.basename(profile), /^screen-authority-smoke-/);
  cleanup = () => rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  let server: ReturnType<typeof createApp> | undefined;
  let userId = '',
    index = 0;
  let screenEpoch = '';
  type Gate = {
    stage: 'before' | 'after';
    entered: boolean;
    ready: Promise<void>;
    notify: () => void;
    waiting: Promise<void>;
    release: () => void;
    completed: Promise<void>;
    finish: () => void;
  };
  let gate: Gate | undefined;
  let rejectNext = false;
  let consumes: number[] = [];
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };
  async function hold(stage: Gate['stage']) {
    const current = gate;
    if (!current || current.stage !== stage || current.entered) return;
    current.entered = true;
    current.notify();
    await current.waiting;
    current.finish();
  }
  async function release() {
    if (!gate) return;
    gate.notify();
    gate.release();
    if (gate.entered) await gate.completed;
    gate = undefined;
  }
  async function end() {
    await release();
    if (!server) return;
    const current = server;
    await current.app.close();
    for (const room of await current.voice!.media.listRooms())
      if (room.name.startsWith(current.voice!.prefix))
        await current.voice!.media.deleteRoom(room.name);
    server = undefined;
  }
  async function control(action: string, args: Record<string, unknown>) {
    if (action === 'begin') {
      await end();
      const username = 'authority_member_' + ++index;
      const user = await auth.register({ username, displayName: 'Synthetic member', password });
      userId = user.id;
      if (args.pending !== true) await auth.changeStatus(ownerLogin.token, userId, 'approve');
      server = createApp({
        databaseUrl: database.url,
        allowedOrigins: [origin],
        voiceConfig: { ...config, prefix: prefix + index + '-' },
      });
      consumes = [];
      rejectNext = false;
      server.app.addHook('preHandler', async (request) => {
        if (request.url === '/api/screen/capture/consume') await hold('before');
      });
      server.app.addHook('onSend', async (request, reply, payload) => {
        if (request.url === '/api/screen/capture/consume') {
          consumes.push(reply.statusCode);
          await hold('after');
        }
        if (rejectNext && request.url === '/api/screen/capture/prepare') {
          rejectNext = false;
          reply.code(503).header('content-type', 'text/plain');
          return 'Synthetic rejected response';
        }
        return payload;
      });
      server.app.get('/fixture/:page', async (_request, reply) =>
        reply
          .header('X-Frame-Options', 'SAMEORIGIN')
          .header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'",
          )
          .type('text/html')
          .send(
            '<!doctype html><title>Owned synthetic fixture</title><body style="background:#263329;color:white">OWNED SYNTHETIC VIDEO<iframe srcdoc="<p>Owned child</p>"></iframe>',
          ),
      );
      await server.app.listen({ host: '127.0.0.1', port: 3006 });
      const channels = await server.voice!.channels(ownerLogin.token);
      return { origin, username, password, channelId: channels[0]!.id };
    }
    if (action === 'end') {
      await end();
      return {};
    }
    assert.ok(server, 'Owned API must be running');
    if (action === 'hold') {
      assert.ok(!gate);
      assert.ok(args.stage === 'before' || args.stage === 'after');
      const ready = deferred(),
        waiting = deferred(),
        completed = deferred();
      gate = {
        stage: args.stage,
        entered: false,
        ready: ready.promise,
        notify: ready.resolve,
        waiting: waiting.promise,
        release: waiting.resolve,
        completed: completed.promise,
        finish: completed.resolve,
      };
      return {};
    }
    if (action === 'wait-held') {
      assert.ok(gate);
      await gate.ready;
      return {};
    }
    if (action === 'release') {
      await release();
      return {};
    }
    if (action === 'reject-next') {
      rejectNext = true;
      return {};
    }
    if (action === 'state') return { consumes };
    const lease = server.voice!.leases.get(userId);
    if (action === 'bind-screen') {
      assert.ok(lease);
      const ownedServer = server;
      const binding = await server.screen!.bind(
        {
          token: lease.token,
          transportId: 'native-authority-fixture-' + index,
          isConnected: () => server === ownedServer,
        },
        { version: 2, leaseId: lease.id, requestId: randomUUID() },
      );
      screenEpoch = binding.epoch;
      return binding;
    }
    if (action === 'publish-screen') {
      assert.ok(lease && screenEpoch);
      const ownedServer = server;
      return server.screen!.publish(
        {
          token: lease.token,
          transportId: 'native-authority-fixture-' + index,
          isConnected: () => server === ownedServer,
        },
        {
          epoch: screenEpoch,
          requestId: randomUUID(),
          sourceGeneration: 1,
          sound: 'none',
          profile: 'smooth',
          resolution: 720,
          frameRate: 60,
          videoBitrate: 4000000,
        },
      );
    }
    if (action === 'preview-lease') {
      assert.ok(lease);
      lease.expires = Date.now() + 5000;
      return {};
    }
    if (action === 'renew-voice') {
      assert.ok(lease);
      await server.voice!.heartbeat(lease.token, { leaseId: lease.id });
      return {};
    }
    if (action === 'csrf') {
      await database.database.pool.query('UPDATE sessions SET csrf_token=$1 WHERE user_id=$2', [
        randomUUID().replaceAll('-', '').repeat(2),
        userId,
      ]);
    } else if (action === 'revoke') {
      await database.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [
        userId,
      ]);
    } else if (action === 'expire' || action === 'short-lease') {
      assert.ok(lease);
      lease.expires = Date.now() + (action === 'expire' ? -1 : 1500);
    } else if (action === 'replace-lease') {
      assert.ok(lease);
      const { token, channelId } = lease;
      await server.voice!.remove(lease);
      await server.voice!.join(token, { channelId });
    } else throw new Error('Unknown fixture control');
    return {};
  }

  const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (key === 'DATABASE_URL' || /^(LIVEKIT_|TRICORD_)/.test(key)) delete env[key];
  const child = spawn(
    require('electron') as string,
    [
      fileURLToPath(new URL('../../../desktop/dist/capture-authority-smoke.js', import.meta.url)),
      '--authority-profile=' + profile,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
  );
  child.stdout!.on('data', (data: Buffer) => process.stdout.write(data));
  child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
  const controls = new Set<Promise<void>>();
  child.on('message', (message: unknown) => {
    const request = message as { id?: number; action?: string; args?: Record<string, unknown> };
    if (!Number.isSafeInteger(request?.id) || typeof request.action !== 'string') return;
    const task = control(request.action, request.args ?? {}).then(
      (value) => {
        if (child.connected) child.send({ id: request.id, value });
      },
      () => {
        if (child.connected)
          child.send({ id: request.id, error: 'Owned fixture control failed: ' + request.action });
      },
    );
    controls.add(task);
    void task.then(
      () => controls.delete(task),
      () => {
        controls.delete(task);
        child.kill();
      },
    );
  });
  const timeout = setTimeout(() => {
    console.error('Authority integration fixture timed out');
    child.kill();
  }, 150000);
  cleanup = async () => {
    clearTimeout(timeout);
    await release();
    await Promise.allSettled(controls);
    try {
      await end();
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  assert.equal(code, 0, 'Electron authority integration failed');
} finally {
  try {
    await cleanup();
  } finally {
    await database.cleanup();
  }
}
