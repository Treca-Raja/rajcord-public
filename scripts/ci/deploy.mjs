import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPublicIPv4, isPublicHost } from '../hosting/init.mjs';
import { checkPolicy } from './policy.mjs';

// All shell-interpolated remote arguments are validated before use.
const env = process.env;
const environment = process.argv[2];
assert.ok(['staging', 'production'].includes(environment));
assert.equal(typeof env.TRICORD_IMAGE, 'string', 'A tested image digest is required.');
await checkPolicy(environment === 'production' ? 'production' : 'main');
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  env.GITHUB_SHA,
  'The deployment files must come from the verified commit.',
);
assert.ok(isPublicIPv4(env.DEPLOY_HOST), 'DEPLOY_HOST must be the environment public IPv4.');
const httpsHost = env.DEPLOY_HTTPS_HOST;
assert.ok(
  isPublicHost(httpsHost),
  'Configure DEPLOY_HTTPS_HOST as the exact HTTPS DNS hostname or public IPv4.',
);
assert.match(env.DEPLOY_USER ?? '', /^[a-z_][a-z0-9_-]{0,31}$/);
const port = env.DEPLOY_PORT || '22';
assert.match(port, /^[0-9]{1,5}$/);
assert.ok(Number(port) > 0 && Number(port) < 65536);
assert.ok(env.DEPLOY_SSH_KEY && env.DEPLOY_KNOWN_HOSTS, 'Configure environment SSH secrets.');
const directory = mkdtempSync(path.join(tmpdir(), 'tricord-ssh-'));
try {
  const key = path.join(directory, 'key');
  const knownHosts = path.join(directory, 'known_hosts');
  writeFileSync(key, env.DEPLOY_SSH_KEY + '\n', { mode: 0o600 });
  writeFileSync(knownHosts, env.DEPLOY_KNOWN_HOSTS + '\n', { mode: 0o600 });
  const args = [
    '-i',
    key,
    '-p',
    port,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'ConnectTimeout=15',
    `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`,
  ];
  const remote = `/opt/tricord/releases/${env.GITHUB_SHA}`;
  const archive = execFileSync(
    'git',
    ['archive', '--format=tar', 'HEAD', 'scripts/hosting', 'infrastructure/hosting'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  // Reuse a completed transfer of this commit; never rewrite it on a retry.
  execFileSync(
    'ssh',
    [
      ...args,
      `set -eu; if [ -d '${remote}' ]; then cat >/dev/null; else umask 077; incoming=$(mktemp -d '${remote}.incoming.XXXXXXXX'); tar -xf - -C "$incoming"; mv "$incoming" '${remote}'; fi`,
    ],
    { input: archive, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  await checkPolicy(environment === 'production' ? 'production' : 'main');
  execFileSync(
    'ssh',
    [
      ...args,
      `sudo -n bash '${remote}/scripts/hosting/deploy.sh' '${environment}' '${env.TRICORD_IMAGE}' '${env.GITHUB_SHA}'`,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--retry',
      '3',
      '--max-time',
      '20',
      `https://${httpsHost}/ready`,
    ],
    { stdio: 'ignore' },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
