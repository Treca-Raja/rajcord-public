import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error This operator tool is JavaScript executed directly by Node.
import { initialize, isPublicIPv4, isPublicHost } from './hosting/init.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tricord-config-test-'));
  directories.push(directory);
  return directory;
};

describe('hosting initialization', () => {
  it('accepts bare DNS names and rejects URL or configuration injection before creating files', () => {
    for (const host of ['rajcord.com', 'turn.rajcord.com', '8.8.8.8'])
      expect(isPublicHost(host)).toBe(true);
    const directory = fixture();
    for (const [index, host] of [
      'https://rajcord.com',
      'rajcord.com:443',
      'localhost',
      '-bad.rajcord.com',
      'rajcord.com\nkeys: unsafe',
      'rajcord.com; echo bad',
      '*.rajcord.com',
      'rajcord..com',
      'rajcord.com/',
      '127.0.0.1',
    ].entries()) {
      expect(isPublicHost(host)).toBe(false);
      const target = path.join(directory, String(index));
      expect(() => initialize('production', '8.8.8.8', target, host)).toThrow();
      expect(existsSync(target)).toBe(false);
    }
  });

  it('keeps public media addressing separate from web and relay TLS identities', () => {
    const target = path.join(fixture(), 'domain');
    initialize('production', '8.8.8.8', target, 'rajcord.com', 'turn.rajcord.com');
    expect(readFileSync(path.join(target, 'app.env'), 'utf8')).toContain(
      'WEB_ORIGINS=https://rajcord.com',
    );
    expect(readFileSync(path.join(target, 'livekit.yaml'), 'utf8')).toContain('node_ip: 8.8.8.8');
    expect(readFileSync(path.join(target, 'livekit.yaml'), 'utf8')).toContain(
      'domain: turn.rajcord.com',
    );
    expect(readFileSync(path.join(target, 'nginx.conf'), 'utf8')).toContain(
      'server_name rajcord.com;',
    );
    expect(readFileSync(path.join(target, 'nginx.conf'), 'utf8')).not.toContain('__PUBLIC_IP__');
    expect(readFileSync(path.join(target, 'public-host'), 'utf8').trim()).toBe('rajcord.com');
    expect(readFileSync(path.join(target, 'turn-host'), 'utf8').trim()).toBe('turn.rajcord.com');
  });

  it('rejects private, reserved and malformed public identities', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.2',
      '172.16.1.1',
      '192.168.1.1',
      '169.254.1.2',
      '100.64.0.1',
      '192.0.2.10',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      '8.8.8.8;echo bad',
    ])
      expect(isPublicIPv4(ip)).toBe(false);
    expect(isPublicIPv4('8.8.8.8')).toBe(true);
    const target = path.join(fixture(), 'invalid');
    expect(() => initialize('preview', '8.8.8.8', target)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('creates independent environments and refuses to replace existing credentials', () => {
    const directory = fixture();
    const staging = path.join(directory, 'staging');
    const production = path.join(directory, 'production');
    initialize('staging', '8.8.8.8', staging);
    initialize('production', '1.1.1.1', production);
    const stageEnv = readFileSync(path.join(staging, 'app.env'), 'utf8');
    const prodEnv = readFileSync(path.join(production, 'app.env'), 'utf8');
    const stagePassword = stageEnv.match(
      /DATABASE_URL=postgresql:\/\/tricord:([a-f0-9]{64})@/,
    )?.[1];
    const prodPassword = prodEnv.match(/DATABASE_URL=postgresql:\/\/tricord:([a-f0-9]{64})@/)?.[1];
    expect(stagePassword).toBeTruthy();
    expect(prodPassword).toBeTruthy();
    expect(stagePassword).not.toBe(prodPassword);
    expect(stageEnv.match(/LIVEKIT_API_SECRET=(.*)/)?.[1]).not.toBe(
      prodEnv.match(/LIVEKIT_API_SECRET=(.*)/)?.[1],
    );
    expect(readFileSync(path.join(staging, 'postgres.env'), 'utf8')).toContain(
      `POSTGRES_PASSWORD=${stagePassword}`,
    );
    expect(stageEnv).toContain('WEB_ORIGINS=https://8.8.8.8');
    expect(stageEnv).toContain('TRUST_PROXY_HOPS=1');
    expect(() => initialize('staging', '8.8.8.8', staging)).toThrow();
    expect(readFileSync(path.join(staging, 'app.env'), 'utf8')).toBe(stageEnv);
  });
});
