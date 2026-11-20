import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const {
  installerName,
  updateManifestName,
  updateManifestPayload,
  updatePublicKey,
  verifyUpdateManifest,
} = require('./dist/update-manifest.js');
const { version } = require('./package.json');
const directory = path.resolve('artifacts/desktop');

const publicKey = process.env.RAJCORD_UPDATE_PUBLIC_KEY;
const verificationKey = updatePublicKey(publicKey);
assert.ok(verificationKey, 'A valid Rajcord update public key is required.');

let privateKey;
try {
  privateKey = createPrivateKey({
    key: Buffer.from(process.env.RAJCORD_UPDATE_PRIVATE_KEY ?? '', 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
} catch {
  throw new Error('A valid Rajcord update signing key is required.');
}
assert.ok(
  createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64') ===
    publicKey,
  'Rajcord update signing key does not match the release public key.',
);

const hash = createHash('sha512');
for await (const chunk of fs.createReadStream(path.join(directory, installerName(version)))) {
  hash.update(chunk);
}
const manifest = { version, sha512: hash.digest('base64') };
const signature = sign(null, updateManifestPayload(manifest), privateKey).toString('base64');
const body = JSON.stringify({ ...manifest, signature }) + '\n';
verifyUpdateManifest(body, verificationKey);
fs.writeFileSync(path.join(directory, updateManifestName), body, { flag: 'wx' });
