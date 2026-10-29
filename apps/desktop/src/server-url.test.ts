import { expect, it } from 'vitest';
import { serverUrl } from './server-url';
it('pins installed clients to production even with development or smoke overrides', () => {
  expect(
    serverUrl(
      { TRICORD_DEV_URL: 'http://127.0.0.1:5173', TRICORD_SERVER_URL: 'https://evil.example' },
      true,
      true,
    ),
  ).toBe('https://rajcord.com');
});
it('keeps development and test origins isolated from remote configuration', () => {
  expect(serverUrl({})).toBe('http://127.0.0.1:3001');
  expect(
    serverUrl({
      TRICORD_DEV_URL: 'http://127.0.0.1:5173',
      TRICORD_SERVER_URL: 'https://tricord.example',
    }),
  ).toBe('http://127.0.0.1:5173');
  expect(serverUrl({ TRICORD_SERVER_URL: 'https://tricord.example' }, true)).toBe(
    'http://127.0.0.1:3002',
  );
  expect(() => serverUrl({ TRICORD_DEV_URL: 'http://remote.example' })).toThrow();
});
it('accepts only exact HTTPS origins for a hosted desktop server', () => {
  expect(serverUrl({ TRICORD_SERVER_URL: 'https://tricord.example' })).toBe(
    'https://tricord.example',
  );
  for (const url of [
    'http://tricord.example',
    'file:///app',
    'https://user:pass@tricord.example',
    'https://tricord.example/path',
    'https://tricord.example/',
    'https://tricord.example?token=secret',
    'invalid',
  ])
    expect(() => serverUrl({ TRICORD_SERVER_URL: url })).toThrow('HTTPS origin');
});
