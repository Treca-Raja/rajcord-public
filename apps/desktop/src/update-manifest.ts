import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export const updateManifestName = 'rajcord-windows-update.json';
export const maxUpdateManifestBytes = 2048;
const downloadBase = 'https://github.com/Treca-Raja/rajcord-public/releases';
export const updateManifestUrl = `${downloadBase}/latest/download/${updateManifestName}`;

export type UpdateManifest = { version: string; sha512: string };

export function installerName(version: string) {
  return `Rajcord-Setup-${version}-x64.exe`;
}

export function installerUrl(version: string) {
  return new URL(`${downloadBase}/download/v${version}/${installerName(version)}`);
}

export function updatePublicKey(value: unknown): KeyObject | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{59}=$/.test(value)) return;
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType === 'ed25519' &&
      key.export({ format: 'der', type: 'spki' }).toString('base64') === value
    )
      return key;
  } catch {
    return;
  }
}

export function updateManifestPayload({ version, sha512 }: UpdateManifest) {
  return Buffer.from(JSON.stringify(['Treca-Raja/rajcord-public/windows-x64/v1', version, sha512]));
}

export function verifyUpdateManifest(raw: string, key: KeyObject): UpdateManifest {
  if (Buffer.byteLength(raw) > maxUpdateManifestBytes)
    throw new Error('Update manifest is too large.');
  const manifest: unknown = JSON.parse(raw);
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid update manifest.');
  const { version, sha512, signature } = manifest as Record<string, unknown>;
  const encodedDigest = /^[A-Za-z0-9+/]{86}==$/;
  if (
    Object.keys(manifest).length !== 3 ||
    typeof version !== 'string' ||
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(version) ||
    typeof sha512 !== 'string' ||
    !encodedDigest.test(sha512) ||
    typeof signature !== 'string' ||
    !encodedDigest.test(signature) ||
    !verify(null, updateManifestPayload({ version, sha512 }), key, Buffer.from(signature, 'base64'))
  )
    throw new Error('Update manifest signature or format is invalid.');
  return { version, sha512 };
}
