import { expect, it } from 'vitest';
import { signatureMatches } from './update-signature';

it('accepts only a valid embedded signature with the exact trusted subject and file', () => {
  const dn = 'CN=Rajcord, O=Example, C=RS';
  const file = "C:\\Users\\Test's PC\\update.exe";
  const valid = { Status: 0, SignatureType: 1, Path: file, SignerCertificate: { Subject: dn } };
  expect(signatureMatches(JSON.stringify(valid), [dn], file)).toBe(true);
  for (const change of [
    { Status: 2 },
    { SignatureType: 2 },
    { Path: 'C:\\other.exe' },
    { SignerCertificate: { Subject: 'CN=Rajcord, O=Attacker, C=RS' } },
    { SignerCertificate: null },
  ])
    expect(signatureMatches(JSON.stringify({ ...valid, ...change }), [dn], file)).toBe(false);
  expect(signatureMatches(JSON.stringify(valid), [], file)).toBe(false);
  expect(signatureMatches('invalid', [dn], file)).toBe(false);
});
