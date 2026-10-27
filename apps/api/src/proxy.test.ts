import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { parseTrustProxyHops } from './proxy-config.js';

const active: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const { app } of active.splice(0)) await app.close();
});

describe('trusted proxy configuration', () => {
  it('requires explicit single-hop trust and rejects ambiguous settings', () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops('0')).toBe(0);
    expect(parseTrustProxyHops('1')).toBe(1);
    for (const value of ['', 'true', 'false', '2', '-1', '1.0', ' 1', '*'])
      expect(() => parseTrustProxyHops(value)).toThrow('TRUST_PROXY_HOPS must be 0 or 1.');
  });

  it('does not let forwarding headers rotate a direct client out of its HTTP quota', async () => {
    const instance = createApp();
    active.push(instance);
    for (let index = 0; index < 120; index++) {
      const response = await instance.app.inject({
        url: '/api/unavailable',
        remoteAddress: '192.0.2.10',
        headers: { 'x-forwarded-for': `198.51.100.${index + 1}` },
      });
      expect(response.statusCode).toBe(503);
    }
    const limited = await instance.app.inject({
      url: '/api/unavailable',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '203.0.113.200' },
    });
    expect(limited.statusCode).toBe(429);
    expect(
      (
        await instance.app.inject({
          url: '/api/unavailable',
          remoteAddress: '192.0.2.11',
          headers: { 'x-forwarded-for': '203.0.113.200' },
        })
      ).statusCode,
    ).toBe(503);
  });

  it('keeps separate client quotas behind the trusted proxy without increasing them', async () => {
    const instance = createApp({ trustProxyHops: 1, trustedProxyAddress: '172.20.0.2' });
    active.push(instance);
    const request = (address: string) =>
      instance.app.inject({
        url: '/api/unavailable',
        remoteAddress: '172.20.0.2',
        headers: { 'x-forwarded-for': address },
      });
    for (let index = 0; index < 120; index++)
      expect((await request('198.51.100.10')).statusCode).toBe(503);
    expect((await request('198.51.100.10')).statusCode).toBe(429);
    expect((await request('198.51.100.11')).statusCode).toBe(503);
    expect((await request('2001:db8::10')).statusCode).toBe(503);
    expect((await instance.app.inject('/health')).statusCode).toBe(200);
  });

  it('rejects malformed forwarding addresses and chains before a handler can run', async () => {
    const instance = createApp({ trustProxyHops: 1, trustedProxyAddress: '172.20.0.2' });
    active.push(instance);
    let reached = 0;
    instance.app.get('/probe', async () => {
      reached++;
      return { ok: true };
    });
    for (const value of [
      '',
      'unknown',
      '198.51.100.2:1234',
      '198.51.100.2, 198.51.100.3',
      ['198.51.100.2', '198.51.100.3'],
    ]) {
      const response = await instance.app.inject({
        url: '/probe',
        remoteAddress: '172.20.0.2',
        headers: { 'x-forwarded-for': value },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(reached).toBe(0);
  });

  it('requires the configured immediate peer as well as a single forwarding hop', async () => {
    expect(() => createApp({ trustProxyHops: 1 })).toThrow('TRUST_PROXY_ADDRESS');
    expect(() => createApp({ trustProxyHops: 1, trustedProxyAddress: '*' })).toThrow(
      'TRUST_PROXY_ADDRESS',
    );
    const instance = createApp({ trustProxyHops: 1, trustedProxyAddress: '172.20.0.2' });
    active.push(instance);
    instance.app.get('/address', async (request) => ({ ip: request.ip }));
    const address = async (peer: string) =>
      (
        await instance.app.inject({
          url: '/address',
          remoteAddress: peer,
          headers: { 'x-forwarded-for': '198.51.100.10' },
        })
      ).json().ip;
    expect(await address('172.20.0.2')).toBe('198.51.100.10');
    expect(await address('::ffff:172.20.0.2')).toBe('198.51.100.10');
    expect(await address('198.51.100.20')).toBe('198.51.100.20');
  });
});
