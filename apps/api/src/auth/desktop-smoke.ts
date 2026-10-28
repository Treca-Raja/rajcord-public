import { voiceConfig } from '../voice/config.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from './service.js';
import { createApp } from '../app.js';
const origin = 'http://127.0.0.1:3002';
const chatOnly = process.argv.includes('--chat-only');
const fixture = await testDatabase(),
  service = new AuthService(fixture.database.pool);
const config = voiceConfig();
if (!config) throw new Error('Run voice:setup and voice:up.');
const server = createApp({
  voiceConfig: { ...config, prefix: 'tricord-desktop-smoke-' + randomUUID() + '-' },
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  rateLimits: false,
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
});
const app = server.app;
app.get('/test/voice-published', async () => {
  for (const lease of server.voice!.leases.values()) {
    const participants = await server.voice!.media.listParticipants(lease.room);
    if (participants.some((p) => p.tracks.some((t) => t.source === 2 && !t.muted)))
      return { published: true };
  }
  return { published: false };
});
const secret = randomUUID() + '-Test',
  username = 'desktop_' + randomUUID().replaceAll('-', '').slice(0, 20);
const profile = await mkdtemp(path.join(tmpdir(), 'tricord-auth-smoke-'));
const desktop = fileURLToPath(new URL('../../../desktop/package.json', import.meta.url));
const electron = createRequire(desktop)('electron') as string;
const passed: string[] = [];
try {
  const owner = await service.bootstrap('owner_' + randomUUID().slice(0, 8), 'Smoke owner', secret);
  await app.listen({ host: '127.0.0.1', port: 3002 });
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    headers: { origin },
    payload: { username: owner.username, password: secret, remember: false },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie']!.toString().split(';')[0]!,
    csrf = login.json().csrfToken;
  for (const stage of ['temporary', 'remember', 'restore']) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRICORD_TEST_PROFILE: profile,
      TRICORD_VOICE_SMOKE: chatOnly ? '0' : '1',
      TRICORD_CHAT_SMOKE_ONLY: chatOnly ? '1' : '0',
      TRICORD_SMOKE_INPUT: JSON.stringify({ stage, username, password: secret }),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(electron, ['.', '--auth-smoke'], {
        cwd: path.dirname(desktop),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let replied = false;
      const replyPoll = setInterval(() => {
        if (stage === 'temporary' && !replied) {
          void (async () => {
            const row = (
              await fixture.database.pool.query(
                "SELECT m.conversation_id FROM messages m JOIN users u ON u.id=m.author_id WHERE u.username=$1 AND m.body LIKE 'Electron says hello%'",
                [username],
              )
            ).rows[0];
            if (!row) return;
            replied = true;
            const result = await app.inject({
              url: '/api/conversations/' + row.conversation_id + '/messages',
              method: 'POST',
              headers: { origin, cookie, 'x-csrf-token': csrf },
              payload: {
                body: 'Reply to Electron https://example.com/reply',
                clientId: randomUUID(),
              },
            });
            assert.equal(result.statusCode, 200);
          })().catch((error) => {
            clearInterval(replyPoll);
            child.kill();
            reject(error);
          });
        }
      }, 200);
      const approvalPoll = setInterval(() => {
        if (stage === 'temporary' && !approved) {
          void (async () => {
            const found = (
              await fixture.database.pool.query(
                "SELECT id FROM users WHERE username=$1 AND status='pending'",
                [username],
              )
            ).rows[0];
            if (!found) return;
            const sessions = await fixture.database.pool.query(
              'SELECT id FROM sessions WHERE user_id=$1',
              [found.id],
            );
            if (!sessions.rowCount) return;
            approved = true;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const res = await app.inject({
              url: '/api/admin/accounts/' + found.id,
              method: 'POST',
              headers: { origin, cookie, 'x-csrf-token': csrf },
              payload: { action: 'approve' },
            });
            assert.equal(res.statusCode, 200);
          })().catch((error) => {
            clearInterval(approvalPoll);
            clearInterval(replyPoll);
            child.kill();
            reject(error);
          });
        }
      }, 200);
      let output = '',
        approved = false,
        stderr = '';
      const timer = setTimeout(() => {
        clearInterval(approvalPoll);
        clearInterval(replyPoll);
        child.kill();
        reject(new Error('Electron smoke timed out. ' + output + stderr));
      }, 60000);
      child.stdin.end();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        clearInterval(approvalPoll);
        clearInterval(replyPoll);
        reject(error);
      });
      child.once('exit', (code) => {
        clearInterval(approvalPoll);
        clearInterval(replyPoll);
        clearTimeout(timer);
        void (async () => {
          const report = JSON.parse(
            await readFile(path.join(profile, 'smoke-' + stage + '.json'), 'utf8'),
          );
          if (code !== 0 || !report.passed)
            throw new Error('Electron smoke failed: ' + output + ' ' + stderr);
          passed.push(stage);
          console.log('PASS Electron ' + stage);
          resolve();
        })().catch(reject);
      });
    });
    const result = await fixture.database.pool.query(
      'SELECT s.remember,s.revoked_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username=$1 ORDER BY s.created_at DESC LIMIT 1',
      [username],
    );
    if (stage === 'temporary' || stage === 'restore')
      assert.ok(result.rows[0]?.revoked_at, 'Quit/logout must revoke the session');
    else assert.equal(result.rows[0]?.revoked_at, null);
  }
  const report = {
    passed,
    checks: [
      'registration UI',
      'pending restriction',
      'real-time approval',
      'approved socket',
      'account settings',
      'logout',
      'minimize retains temporary session',
      'full quit revokes temporary session',
      'restart requires sign-in',
      'remembered session survives restart',
      'logout revokes remembered session',
      'renderer isolation',
      'no localStorage tokens',
      'composer persists message',
      'independent-session realtime reply',
      'own history survives app restart',
      'received history survives app restart',
      'secure chat hyperlinks after send, receive and restart',
      ...(chatOnly
        ? []
        : [
            'camera capture denied',
            'explicit voice devices',
            'voice joins muted',
            'microphone reaches LiveKit',
            'deafen control',
            'manual voice leave',
          ]),
      'notification IPC rejects invalid payload',
      'Windows development notification registration',
      'native notification reports show event',
    ],
    profile,
  };
  await mkdir(fileURLToPath(new URL('../../../../artifacts/', import.meta.url)), {
    recursive: true,
  });
  await writeFile(
    fileURLToPath(new URL('../../../../artifacts/auth-desktop.json', import.meta.url)),
    JSON.stringify(report, null, 2),
  );
  console.log(
    'PASS: ' +
      report.checks.length +
      ' Electron authentication, messaging, ' +
      (chatOnly ? '' : 'voice, ') +
      'notification and lifecycle checks across 3 launches.',
  );
} finally {
  await app.close();
  for (const room of await server.voice!.media.listRooms())
    if (room.name.startsWith(server.voice!.prefix)) await server.voice!.media.deleteRoom(room.name);
  await fixture.cleanup();
}
