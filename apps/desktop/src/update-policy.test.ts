import { expect, it } from 'vitest';
import { trustedUpdateConfig } from './update-policy';
it('refuses updates without a pinned public release repository and publisher', () => {
  const config = {
    provider: 'github',
    owner: 'Treca-Raja',
    repo: 'tricord-public',
    publisherName: ['CN=Trusted, O=Example, C=RS'],
  };
  expect(trustedUpdateConfig(config)).toBe(true);
  for (const change of [
    { publisherName: undefined },
    { publisherName: [] },
    { publisherName: 'Trusted' },
    { publisherName: [null] },
    { provider: 'generic' },
    { owner: 'attacker' },
    { repo: 'other' },
    { verifyUpdateCodeSignature: false },
  ])
    expect(trustedUpdateConfig({ ...config, ...change })).toBe(false);
  expect(trustedUpdateConfig(null)).toBe(false);
});
