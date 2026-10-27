import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export function isPublicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function isPublicHost(value) {
  if (typeof value !== 'string') return false;
  if (isIP(value)) return isPublicIPv4(value);
  return (
    value.length <= 253 &&
    value.split('.').length >= 2 &&
    value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z][a-z0-9-]*[a-z0-9]$/.test(value.split('.').at(-1))
  );
}

export function initialize(
  environment,
  publicIP,
  target,
  publicHost = publicIP,
  turnHost = publicHost,
) {
  if (!['staging', 'production'].includes(environment))
    throw new Error('Environment must be staging or production.');
  if (!isPublicIPv4(publicIP)) throw new Error('A routable public IPv4 address is required.');
  if (!isPublicHost(publicHost) || !isPublicHost(turnHost))
    throw new Error('Use lowercase DNS hostnames or a routable public IPv4 for TLS identities.');
  if ((isIP(publicHost) || isIP(turnHost)) && publicHost !== turnHost)
    throw new Error('IP-only TLS must use one shared public IP identity.');
  if (!target || !path.isAbsolute(target)) throw new Error('Use an absolute runtime directory.');
  const directory = path.resolve(target);
  const relative = path.relative(repository, directory);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative) &&
      !relative.startsWith('.local' + path.sep))
  )
    throw new Error(
      'Keep generated configuration outside the checkout, or under its ignored .local/.',
    );

  // mkdir without recursive deliberately refuses an existing directory or symlink.
  // Create its parent beforehand. Never regenerate credentials in an initialized host.
  mkdirSync(directory, { mode: 0o700 });
  const write = (name, value) =>
    writeFileSync(path.join(directory, name), value, { flag: 'wx', mode: 0o600 });
  write('.gitignore', '*\n');
  write('environment', environment + '\n');
  write('public-ip', publicIP + '\n');
  write('public-host', publicHost + '\n');
  write('turn-host', turnHost + '\n');
  const databasePassword = randomBytes(32).toString('hex');
  const livekitKey = 'tricord-' + environment + '-' + randomBytes(8).toString('hex');
  const livekitSecret = randomBytes(32).toString('hex');
  write(
    'postgres.env',
    `POSTGRES_USER=tricord\nPOSTGRES_DB=tricord\nPOSTGRES_PASSWORD=${databasePassword}\n`,
  );
  write(
    'app.env',
    `NODE_ENV=production\nHOST=0.0.0.0\nPORT=3001\nTRUST_PROXY_HOPS=1\nTRUST_PROXY_ADDRESS=172.30.241.2\nWEB_ORIGINS=https://${publicHost}\nDATABASE_URL=postgresql://tricord:${databasePassword}@postgres:5432/tricord\nLIVEKIT_URL=http://livekit:7880\nLIVEKIT_API_KEY=${livekitKey}\nLIVEKIT_API_SECRET=${livekitSecret}\n`,
  );
  write(
    'livekit.yaml',
    `port: 7880
bind_addresses: ['0.0.0.0']
rtc:
  tcp_port: 7881
  udp_port: 7882
  node_ip: ${publicIP}
  use_external_ip: false
  enable_loopback_candidate: false
turn:
  enabled: true
  bind_addresses: ['0.0.0.0']
  domain: ${turnHost}
  tls_port: 5349
  udp_port: 3478
  relay_range_start: 50000
  relay_range_end: 50199
  cert_file: /etc/letsencrypt/live/tricord/fullchain.pem
  key_file: /etc/letsencrypt/live/tricord/privkey.pem
keys:
  ${livekitKey}: ${livekitSecret}
logging:
  level: error
`,
  );
  for (const name of ['nginx.conf', 'nginx-bootstrap.conf']) {
    const template = readFileSync(
      new URL(`../../infrastructure/hosting/${name}.template`, import.meta.url),
      'utf8',
    );
    write(name, template.replaceAll('__PUBLIC_IP__', publicHost));
  }
  mkdirSync(path.join(directory, 'acme'), { mode: 0o755 });
  mkdirSync(path.join(directory, 'letsencrypt'), { mode: 0o700 });
  console.log(`Initialized ${environment} runtime configuration; no credentials printed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 5 || process.argv.length > 7)
      throw new Error(
        'Usage: node scripts/hosting/init.mjs staging|production PUBLIC_IPV4 ABSOLUTE_DIRECTORY [PUBLIC_HOST [TURN_HOST]]',
      );
    initialize(...process.argv.slice(2));
  } catch (error) {
    console.error(
      error?.code === 'EEXIST'
        ? 'Runtime directory already exists. Nothing was overwritten; preserve its existing secrets.'
        : error?.code
          ? 'Initialization failed. Check the parent directory and permissions; preserve any files already created.'
          : error.message,
    );
    process.exitCode = 1;
  }
}
