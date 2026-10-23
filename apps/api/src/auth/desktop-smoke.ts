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
const fixture = await testDatabase(),
  service = new AuthService(fixture.database.pool);
const app = createApp({
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  rateLimits: false,
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
}).app;
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
        reject(error);
      });
      child.once('exit', (code) => {
        clearInterval(approvalPoll);
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
  console.log('PASS: 13 Electron authentication/lifecycle assertions across 3 launches.');
} finally {
  await app.close();
  await fixture.cleanup();
}
