import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NsisUpdater } from 'electron-updater';
import { afterEach, expect, it, vi } from 'vitest';
import { configureManifestUpdateFeed } from './manifest-update-feed';
import {
  maxUpdateManifestBytes,
  updateManifestPayload,
  updateManifestUrl,
} from './update-manifest';

const keys = generateKeyPairSync('ed25519');
const installerBytes = 'test installer bytes';
const sha512 = createHash('sha512').update(installerBytes).digest('base64');

function release(version: string, signer = keys.privateKey) {
  const manifest = { version, sha512 };
  const signature = sign(null, updateManifestPayload(manifest), signer).toString('base64');
  return new Response(JSON.stringify({ ...manifest, signature }));
}

async function withUpdater(run: (updater: NsisUpdater, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rajcord-update-feed-'));
  try {
    const config = path.join(directory, 'package.json');
    await writeFile(config, JSON.stringify({ updaterCacheDirName: 'test' }));
    const updater = new NsisUpdater(undefined, {
      name: 'Rajcord',
      version: '0.1.1',
      isPackaged: true,
      appUpdateConfigPath: config,
      userDataPath: directory,
      baseCachePath: directory,
      whenReady: async () => {},
      relaunch: vi.fn(),
      quit: vi.fn(),
      onQuit: vi.fn(),
    });
    updater.logger = null;
    updater.autoDownload = false;
    updater.allowDowngrade = false;
    configureManifestUpdateFeed(updater, keys.publicKey, config);
    await run(updater, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

afterEach(() => vi.unstubAllGlobals());

it('offers a verified newer release through the installed Electron updater provider API', async () => {
  const fetch = vi.fn().mockResolvedValue(release('0.1.2'));
  vi.stubGlobal('fetch', fetch);
  await withUpdater(async (updater, directory) => {
    const offer = vi.fn();
    updater.on('update-available', offer);
    const check = await updater.checkForUpdates();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(updateManifestUrl, {
      signal: expect.any(AbortSignal),
    });
    expect(check?.updateInfo.files).toEqual([{ url: 'Rajcord-Setup-0.1.2-x64.exe', sha512 }]);
    expect(offer).toHaveBeenCalledOnce();
    const cache = path.join(directory, 'test', 'pending');
    const file = path.join(cache, 'Rajcord-Setup-0.1.2-x64.exe');
    await mkdir(cache, { recursive: true });
    await writeFile(file, installerBytes);
    await writeFile(
      path.join(cache, 'update-info.json'),
      JSON.stringify({ fileName: path.basename(file), sha512 }),
    );
    await expect(updater.downloadUpdate()).resolves.toEqual([file]);
  });
});

it('does not offer a downgrade or a release without Rajcord metadata', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(release('0.1.0'))
      .mockResolvedValueOnce(new Response(null, { status: 404 })),
  );
  await withUpdater(async (updater) => {
    const offer = vi.fn();
    updater.on('update-available', offer);
    await updater.checkForUpdates();
    await updater.checkForUpdates();
    expect(offer).not.toHaveBeenCalled();
  });
});

it('rejects a foreign signature and bounds the response before parsing', async () => {
  const foreign = generateKeyPairSync('ed25519');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(release('0.1.2', foreign.privateKey))
      .mockResolvedValueOnce(new Response(' '.repeat(maxUpdateManifestBytes + 1))),
  );
  await withUpdater(async (updater) => {
    const offer = vi.fn();
    updater.on('update-available', offer);
    await expect(updater.checkForUpdates()).rejects.toThrow('signature or format');
    await expect(updater.checkForUpdates()).rejects.toThrow('too large');
    expect(offer).not.toHaveBeenCalled();
  });
});
