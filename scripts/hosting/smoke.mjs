import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialize } from './init.mjs';

const image = process.argv[2] ?? 'tricord-server:alpha';
const project = 'tricord-hosting-test-' + randomBytes(6).toString('hex');
const directory = mkdtempSync(path.join(tmpdir(), project + '-'));
const config = path.join(directory, 'runtime');
const ip = '8.8.8.8'; // Advertised fixture address only; clients resolve HTTPS explicitly to loopback.
const publicHost = 'rajcord-fixture.test';
const turnHost = 'turn.rajcord-fixture.test';
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
const environment = {
  ...process.env,
  TRICORD_ENVIRONMENT: 'staging',
  TRICORD_CONFIG_DIR: config,
  TRICORD_IMAGE: image,
};
const composeArgs = [
  'compose',
  '--project-name',
  project,
  '--file',
  'infrastructure/hosting/compose.yaml',
  '--file',
  path.join(directory, 'override.yaml'),
];
const compose = (args, options = {}) =>
  run('docker', [...composeArgs, ...args], { env: environment, ...options });
let started = false;
let phase = 'operator fixtures';
try {
  const root = path.resolve(import.meta.dirname, '../..');
  const operations = run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0',
    '--mount',
    `type=bind,source=${path.join(root, 'scripts/hosting')},target=/fixture/scripts/hosting,readonly`,
    '--mount',
    `type=bind,source=${path.join(root, 'infrastructure/hosting')},target=/fixture/infrastructure/hosting,readonly`,
    '--entrypoint',
    'bash',
    image,
    '-c',
    'bash /fixture/scripts/hosting/operations-test.sh && bash /fixture/scripts/hosting/ssh-test.sh',
  ]);
  process.stdout.write(operations);
  phase = 'fixture configuration and certificate';
  initialize('staging', ip, config, publicHost, turnHost);
  const certs = path.join(config, 'letsencrypt', 'live', 'tricord');
  mkdirSync(certs, { recursive: true });
  const openssl =
    process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
      ? 'C:/Program Files/Git/usr/bin/openssl.exe'
      : 'openssl';
  run(openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Tricord disposable hosting fixture',
    '-addext',
    `subjectAltName=DNS:${publicHost},DNS:${turnHost}`,
    '-keyout',
    path.join(certs, 'privkey.pem'),
    '-out',
    path.join(certs, 'fullchain.pem'),
  ]);
  writeFileSync(
    path.join(directory, 'override.yaml'),
    `services:
  postgres:
    volumes: !override
      - type: tmpfs
        target: /var/lib/postgresql/data
  livekit:
    ports: !reset []
    # Linux fixture files belong to the runner; production files belong to root.
    # Match that owner without granting DAC override or relaxing mode 600.
    user: '${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}'
  proxy:
    ports: !override ['127.0.0.1::443/tcp']
volumes: !reset {}
`,
  );
  // Parse without printing expanded env_file secrets, and enforce no named fixture volumes.
  phase = 'Compose configuration';
  const parsed = JSON.parse(compose(['config', '--format', 'json']));
  assert.equal(Object.keys(parsed.volumes ?? {}).length, 0);
  assert.equal(parsed.services.postgres.ports, undefined);
  assert.equal(parsed.services.app.ports, undefined);
  assert.equal(parsed.services.livekit.ports?.length ?? 0, 0);
  started = true;
  phase = 'database startup';
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres']);
  phase = 'migrations';
  compose(['run', '--rm', '--no-deps', 'app', 'node', 'dist/migrate.js']);
  phase = 'application and proxy startup';
  compose(['up', '-d', '--wait', '--wait-timeout', '180', 'app', 'proxy']);
  phase = 'proxy syntax';
  compose(['exec', '-T', 'proxy', 'nginx', '-t']);
  const port = compose(['port', 'proxy', '443']).toString().trim().split(':').at(-1);
  assert.match(port, /^[0-9]+$/);
  const headersFile = path.join(directory, 'headers');
  const request = (route, extra = []) =>
    run('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--noproxy',
      '*',
      '--max-time',
      '20',
      '--cacert',
      path.join(certs, 'fullchain.pem'),
      '--resolve',
      `${publicHost}:${port}:127.0.0.1`,
      '--dump-header',
      headersFile,
      ...extra,
      `https://${publicHost}:${port}${route}`,
    ]).toString();
  phase = 'trusted HTTPS readiness';
  assert.equal(JSON.parse(request('/ready')).database, 'connected');
  assert.match(request('/'), /<title>Tricord/);
  assert.equal(
    JSON.parse(request('/health', ['--header', 'X-Forwarded-For: spoofed, 1.2.3.4'])).status,
    'ok',
  );
  const password = randomBytes(24).toString('hex');
  phase = 'registration and secure login cookies';
  const post = (route, body) =>
    request(route, [
      '--header',
      `Origin: https://${publicHost}`,
      '--header',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(body),
    ]);
  post('/api/auth/register', {
    username: 'hosting_fixture',
    displayName: 'Disposable fixture',
    password,
  });
  post('/api/auth/login', { username: 'hosting_fixture', password, remember: false });
  const headers = readFileSync(headersFile, 'utf8');
  assert.match(headers, /set-cookie:.*; Secure/i);
  assert.match(headers, /set-cookie:.*; HttpOnly/i);
  assert.match(headers, /set-cookie:.*SameSite=Strict/i);
  phase = 'TURN TLS and private voice control';
  compose(['exec', '-T', 'app', 'node', '--input-type=module'], {
    input: `
    import assert from 'node:assert/strict';
    import {connect, checkServerIdentity} from 'node:tls';
    import {RoomServiceClient} from 'livekit-server-sdk';
    await new Promise((resolve, reject) => {
      const socket = connect({host: 'livekit', port: 5349, servername: '${turnHost}', ca: ${JSON.stringify(readFileSync(path.join(certs, 'fullchain.pem'), 'utf8'))}, checkServerIdentity: (_host, cert) => checkServerIdentity('${turnHost}', cert)}, () => { socket.end(); resolve(); });
      socket.setTimeout(5000, () => socket.destroy(new Error('TURN TLS timeout')));
      socket.on('error', reject);
    });
    const client = new RoomServiceClient(process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    const room = await client.createRoom({name: 'disposable-hosting-fixture', emptyTimeout: 10});
    assert.equal(room.name, 'disposable-hosting-fixture');
    await client.deleteRoom(room.name);
  `,
  });
  console.log(
    'PASS: isolated hosted Compose, tmpfs database, migrations, domain HTTPS and TURN TLS identities, forwarding-header replacement, Secure login cookies and private LiveKit control.',
  );
} catch (error) {
  console.error(`Hosted-stack verification failed during ${phase}.`);
  if (Number.isInteger(error.status)) console.error(`Command exit status: ${error.status}.`);
  if (started) {
    try {
      const states = compose(['ps', '--all', '--format', 'json']).toString().trim();
      const services = states.startsWith('[')
        ? JSON.parse(states)
        : states
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      for (const service of services)
        console.error(
          `Fixture service ${service.Service}: state=${service.State}, health=${service.Health || 'none'}, exit=${service.ExitCode}.`,
        );
    } catch {
      console.error('Fixture service state could not be read.');
    }
  }
  console.error(
    error instanceof assert.AssertionError
      ? 'A hosted fixture assertion failed; response headers and cookies were not printed.'
      : 'Hosted-stack verification failed. Raw container configuration and credentials were not printed.',
  );
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      compose(['down', '--remove-orphans']);
    } catch {
      process.exitCode = 1;
      console.error('Disposable hosted-stack cleanup failed.');
    }
  }
  if (
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith(project + '-')
  )
    rmSync(directory, { recursive: true, force: true });
}
