import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  installerUrl,
  maxUpdateManifestBytes,
  updateManifestPayload,
  updatePublicKey,
  verifyUpdateManifest,
} from './update-manifest';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const manifest = {
  version: '0.1.2',
  sha512: createHash('sha512').update('fixture installer').digest('base64'),
};
const envelope = {
  ...manifest,
  signature: sign(null, updateManifestPayload(manifest), privateKey).toString('base64'),
};

it('accepts Rajcord metadata and derives the installer URL solely from the verified version', () => {
  const key = updatePublicKey(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  expect(key).toBeDefined();
  expect(verifyUpdateManifest(JSON.stringify(envelope), key!)).toEqual(manifest);
  expect(installerUrl(manifest.version).href).toBe(
    'https://github.com/Treca-Raja/rajcord-public/releases/download/v0.1.2/Rajcord-Setup-0.1.2-x64.exe',
  );
});

it.each([
  { version: '0.1.3' },
  { sha512: createHash('sha512').update('replacement installer').digest('base64') },
  { url: 'https://example.test/setup.exe' },
  { signature: undefined },
])('rejects changes to a signed envelope %j', (change) => {
  expect(() =>
    verifyUpdateManifest(JSON.stringify({ ...envelope, ...change }), publicKey),
  ).toThrow();
});

it.each(['0.1.02', '0.1.2-beta.1', '../0.1.2', '0.1.2/foo'])(
  'rejects invalid or prerelease versions even when signed %s',
  (version) => {
    const candidate = { ...manifest, version };
    const signature = sign(null, updateManifestPayload(candidate), privateKey).toString('base64');
    expect(() =>
      verifyUpdateManifest(JSON.stringify({ ...candidate, signature }), publicKey),
    ).toThrow();
  },
);

it('rejects unrelated public keys, invalid packaged keys and oversized manifests', () => {
  const unrelated = generateKeyPairSync('ed25519');
  expect(() => verifyUpdateManifest(JSON.stringify(envelope), unrelated.publicKey)).toThrow();
  expect(
    updatePublicKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')),
  ).toBeUndefined();
  expect(() => verifyUpdateManifest(' '.repeat(maxUpdateManifestBytes + 1), publicKey)).toThrow();
});
