import type { KeyObject } from 'node:crypto';
import { Provider, type NsisUpdater, type UpdateCheckResult } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import {
  installerName,
  installerUrl,
  maxUpdateManifestBytes,
  updateManifestUrl,
  verifyUpdateManifest,
} from './update-manifest.js';

async function readManifestResponse(response: Response) {
  if (!response.ok || !response.body) throw new Error('Update manifest is unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      size += value.length;
      if (size > maxUpdateManifestBytes) throw new Error('Update manifest is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}

type UpdateInfo = UpdateCheckResult['updateInfo'];

export function configureManifestUpdateFeed(
  updater: NsisUpdater,
  key: KeyObject,
  configPath: string,
) {
  updater.updateConfigPath = configPath;
  updater.disableDifferentialDownload = true;
  updater.setFeedURL({
    provider: 'custom',
    updateProvider: class extends Provider<UpdateInfo> {
      constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) {
        super(runtime);
      }

      async getLatestVersion(): Promise<UpdateInfo> {
        const response = await fetch(updateManifestUrl, { signal: AbortSignal.timeout(10_000) });
        if (response.status === 404)
          return {
            version: updater.currentVersion.version,
            path: '',
            sha512: '',
            files: [],
            releaseDate: '',
          };
        const { version, sha512 } = verifyUpdateManifest(await readManifestResponse(response), key);
        const file = installerName(version);
        return { version, path: file, sha512, files: [{ url: file, sha512 }], releaseDate: '' };
      }

      resolveFiles(info: UpdateInfo) {
        return info.files.map((file) => ({ info: file, url: installerUrl(info.version) }));
      }
    },
  });
}
