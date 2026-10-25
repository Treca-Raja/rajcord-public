import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const image = process.argv[2] ?? 'tricord-server:alpha';
const name = 'tricord-image-test-' + randomBytes(6).toString('hex');
const directory = mkdtempSync(path.join(tmpdir(), name + '-'));
const password = randomBytes(32).toString('hex');
const voiceSecret = randomBytes(32).toString('hex');
const accountPassword = randomBytes(24).toString('hex');
const dbEnv = path.join(directory, 'database.env'),
  apiEnv = path.join(directory, 'api.env');
const mediaEnv = path.join(directory, 'media.env');
writeFileSync(
  dbEnv,
  'POSTGRES_USER=tricord\nPOSTGRES_DB=tricord\nPOSTGRES_PASSWORD=' + password + '\n',
  { mode: 0o600 },
);
writeFileSync(
  apiEnv,
  'DATABASE_URL=postgresql://tricord:' +
    password +
    '@postgres:5432/tricord\nWEB_ORIGINS=https://tricord.test\nLIVEKIT_URL=http://livekit:7880\nLIVEKIT_API_KEY=image-test\nLIVEKIT_API_SECRET=' +
    voiceSecret +
    '\n',
  { mode: 0o600 },
);
writeFileSync(
  mediaEnv,
  'LIVEKIT_CONFIG=' +
    JSON.stringify({
      port: 7880,
      bind_addresses: ['0.0.0.0'],
      keys: { 'image-test': voiceSecret },
      rtc: {
        tcp_port: 7881,
        udp_port: 7882,
        node_ip: '127.0.0.1',
        use_external_ip: false,
        enable_loopback_candidate: false,
      },
      logging: { level: 'warn' },
    }) +
    '\n',
  { mode: 0o600 },
);
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const containers = [];
let networkCreated = false;
try {
  docker(['network', 'create', name]);
  networkCreated = true;
  docker([
    'run',
    '-d',
    '--name',
    name + '-db',
    '--network',
    name,
    '--network-alias',
    'postgres',
    '--tmpfs',
    '/var/lib/postgresql/data:rw',
    '--env-file',
    dbEnv,
    'postgres:17-alpine',
  ]);
  containers.push(name + '-db');
  docker([
    'run',
    '-d',
    '--name',
    name + '-livekit',
    '--network',
    name,
    '--network-alias',
    'livekit',
    '--env-file',
    mediaEnv,
    'livekit/livekit-server:v1.13.10',
  ]);
  containers.push(name + '-livekit');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      docker(['exec', name + '-db', 'pg_isready', '-U', 'tricord']);
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  for (let i = 0; i < 2; i++)
    docker([
      'run',
      '--rm',
      '--network',
      name,
      '--env-file',
      apiEnv,
      image,
      'node',
      'dist/migrate.js',
    ]);
  docker([
    'run',
    '-d',
    '--name',
    name + '-api',
    '--network',
    name,
    '--env-file',
    apiEnv,
    '-p',
    '127.0.0.1::3001',
    image,
  ]);
  containers.push(name + '-api');
  const info = JSON.parse(docker(['inspect', name + '-api']).toString())[0];
  assert.equal(info.Config.User, 'node');
  const port = info.NetworkSettings.Ports['3001/tcp'][0].HostPort;
  const origin = 'http://127.0.0.1:' + port;
  ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/ready')).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Starting. */
    }
    await delay(100);
  }
  assert.ok(ready, 'Server image did not become database-ready');
  const home = await fetch(origin + '/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<title>Tricord/);
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
  const post = (url, body) =>
    fetch(origin + url, {
      method: 'POST',
      headers: { Origin: 'https://tricord.test', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post('/api/auth/register', {
        username: 'image_test',
        displayName: 'Disposable image test',
        password: accountPassword,
      })
    ).status,
    201,
  );
  const login = await post('/api/auth/login', {
    username: 'image_test',
    password: accountPassword,
    remember: true,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.ok(/; Secure/i.test(cookie), 'Expected Secure session cookie');
  assert.ok(/; HttpOnly/i.test(cookie), 'Expected HttpOnly session cookie');
  assert.ok(/SameSite=Strict/i.test(cookie), 'Expected SameSite=Strict session cookie');
  assert.equal(
    (await fetch(origin + '/api/conversations', { headers: { Cookie: cookie.split(';')[0] } }))
      .status,
    403,
  );
  docker(
    ['exec', '-i', name + '-api', 'node', '--input-type=module'],
    `
    import {createDatabase} from './dist/db/client.js';
    import {AuthService} from './dist/auth/service.js';
    const db=createDatabase(process.env.DATABASE_URL);
    try { await new AuthService(db.pool).bootstrap('image_owner','Image owner',${JSON.stringify(accountPassword)}); }
    finally { await db.pool.end(); }
  `,
  );
  const ownerLogin = await post('/api/auth/login', {
    username: 'image_owner',
    password: accountPassword,
    remember: true,
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  const ownerState = await ownerLogin.json();
  const headers = {
    Cookie: ownerCookie,
    Origin: 'https://tricord.test',
    'Content-Type': 'application/json',
    'x-csrf-token': ownerState.csrfToken,
  };
  const channels = await (await fetch(origin + '/api/voice/channels', { headers })).json();
  const joined = await fetch(origin + '/api/voice/join', {
    method: 'POST',
    headers,
    body: JSON.stringify({ channelId: channels.channels[0].id }),
  });
  assert.equal(joined.status, 200);
  const lease = await joined.json();
  assert.equal(lease.credential, lease.id);
  assert.equal(lease.useServerIceServers, true);
  assert.equal(
    (
      await fetch(origin + '/api/voice/leave', {
        method: 'POST',
        headers,
        body: JSON.stringify({ leaseId: lease.id }),
      })
    ).status,
    200,
  );
  const sql = (database, query) =>
    docker(['exec', name + '-db', 'psql', '-U', 'tricord', '-d', database, '-Atc', query])
      .toString()
      .trim();
  const before = sql('tricord', 'SELECT count(*) FROM drizzle.__drizzle_migrations');
  const backup = docker(['exec', name + '-db', 'pg_dump', '-U', 'tricord', '-d', 'tricord', '-Fc']);
  docker(['exec', name + '-db', 'createdb', '-U', 'tricord', 'tricord_restorecheck']);
  docker(
    [
      'exec',
      '-i',
      name + '-db',
      'pg_restore',
      '-U',
      'tricord',
      '-d',
      'tricord_restorecheck',
      '--exit-on-error',
    ],
    backup,
  );
  assert.equal(
    sql('tricord_restorecheck', "SELECT username FROM users WHERE username='image_test'"),
    'image_test',
  );
  assert.equal(
    sql('tricord_restorecheck', 'SELECT count(*) FROM drizzle.__drizzle_migrations'),
    before,
  );
  console.log(
    'PASS: non-root production image, migrations twice, web assets, database readiness, registration/login, Secure cookies, pending-account denial, private LiveKit control and backup/restore.',
  );
} catch (error) {
  // Never dump docker inspect/environment output, HTTP cookies or connection strings.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : String(error.stderr || error.message)
          .replaceAll(password, '[redacted]')
          .replaceAll(voiceSecret, '[redacted]')
          .replaceAll(accountPassword, '[redacted]'),
  );
  process.exitCode = 1;
} finally {
  for (const container of containers.reverse()) {
    try {
      docker(['rm', '-f', container]);
    } catch {
      process.exitCode = 1;
      console.error('Test container cleanup failed.');
    }
  }
  if (networkCreated)
    try {
      docker(['network', 'rm', name]);
    } catch {
      process.exitCode = 1;
      console.error('Test network cleanup failed.');
    }
  if (
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith(name + '-')
  )
    rmSync(directory, { recursive: true, force: true });
}
