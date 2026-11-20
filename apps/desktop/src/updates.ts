import { app, dialog, shell } from 'electron';
import type { NsisUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, type KeyObject } from 'node:crypto';
import { load } from 'js-yaml';
import { verifyUpdateSignature } from './update-signature.js';
import { trustedUpdateConfig } from './update-policy.js';
import { RecoverableNsisUpdater } from './update-installer.js';
import { configureManifestUpdateFeed } from './manifest-update-feed.js';
import { installerName, updatePublicKey } from './update-manifest.js';

function packagedUpdateTrust() {
  let config: unknown;
  try {
    config = load(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    const configPath = path.join(app.getAppPath(), 'package.json');
    const { rajcordUpdatePublicKey } = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      rajcordUpdatePublicKey?: unknown;
    };
    const key = updatePublicKey(rajcordUpdatePublicKey);
    if (key) return { key, configPath };
    return;
  }
  if (trustedUpdateConfig(config))
    return {
      publishers: Array.isArray(config.publisherName)
        ? config.publisherName
        : [config.publisherName],
    };
}

export function configureUpdates(
  prepareInstall: () => Promise<void>,
  installFailed: () => void = () => {},
  updateProgress: (progress: number) => void = () => {},
) {
  let updater: NsisUpdater | undefined;
  let publishers: string[] = [];
  let manifestTrust: { key: KeyObject; configPath: string } | undefined;
  let busy = false;
  let ready = false;
  let downloadedFile: string | undefined;
  let downloadedHash: string | undefined;
  let recreateUpdater = false;
  let installingUpdater: NsisUpdater | undefined;
  const hashFile = (file: string) =>
    createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  let available = false;
  let timer: NodeJS.Timeout | undefined;
  const show = (message: string) =>
    dialog.showMessageBox({ type: 'info', title: 'Rajcord updates', message });
  const reportInstallerFailure = (instance: NsisUpdater) => {
    if (installingUpdater !== instance) return;
    installingUpdater = undefined;
    ready = false;
    // v6 can retain its install-once flag after an asynchronous launch failure.
    // A fresh updater will recheck the feed and reverify any cached download.
    recreateUpdater = true;
    installFailed();
    void show('The update installer failed. Check for updates and try again.').catch(() => {
      /* A dialog can be unavailable while Windows is shutting down. */
    });
  };
  const createUpdater = () => {
    const instance: NsisUpdater = new RecoverableNsisUpdater(() => installingUpdater === instance);
    instance.verifyUpdateCodeSignature = verifyUpdateSignature;
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = false;
    instance.allowPrerelease = false;
    instance.allowDowngrade = false;
    instance.disableWebInstaller = true;
    instance.logger = null; // Do not log URLs, downloaded metadata or profiles.
    if (manifestTrust)
      configureManifestUpdateFeed(instance, manifestTrust.key, manifestTrust.configPath);
    instance.on('error', () => {
      if (instance !== updater) return;
      ready = false;
      reportInstallerFailure(instance);
    });
    instance.on('update-available', () => {
      if (instance === updater) available = true;
    });
    return instance;
  };
  if (app.isPackaged && process.platform === 'win32') {
    try {
      const trust = packagedUpdateTrust();
      if (trust) {
        if (trust.publishers) publishers = trust.publishers;
        else manifestTrust = trust;
        updater = createUpdater();
      }
    } catch {
      /* Missing or invalid packaged trust configuration disables updates. */
    }
  }
  const install = async (restartApproved = false) => {
    if (!updater || !ready || busy || installingUpdater) return;
    busy = true;
    let installerCalled = false;
    try {
      if (
        !restartApproved &&
        (
          await dialog.showMessageBox({
            type: 'question',
            title: 'Restart Rajcord?',
            message: 'Restart Rajcord to install the verified update?',
            detail: 'This disconnects any active voice call.',
            buttons: ['Later', 'Restart and install'],
            defaultId: 0,
            cancelId: 0,
          })
        ).response !== 1
      )
        return;
      const file = downloadedFile;
      let verified = false;
      try {
        verified =
          !!file &&
          hashFile(file) === downloadedHash &&
          (manifestTrust !== undefined || (await verifyUpdateSignature(publishers, file)) === null);
      } catch {
        /* Removed/unreadable cached files cannot be installed. */
      }
      if (!verified || !file) {
        ready = false;
        await show('The update signature could not be verified. Installation was blocked.');
        return;
      }
      await prepareInstall();
      if (manifestTrust) {
        // Session cleanup can await the server. Check the cached file again just before launch.
        if (hashFile(file) !== downloadedHash) {
          ready = false;
          throw new Error('The cached installer changed.');
        }
        installingUpdater = updater;
        installerCalled = true;
        // Preserve Windows' normal handling for a downloaded executable.
        fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
        if (await shell.openPath(file)) throw new Error('Windows did not open the installer.');
        app.quit();
        return;
      }
      installingUpdater = updater;
      installerCalled = true;
      updater.quitAndInstall(false, true);
    } catch {
      if (installerCalled) reportInstallerFailure(updater);
      else {
        installFailed();
        await show('Rajcord could not prepare to install the update. Please try again.');
      }
    } finally {
      busy = false;
    }
  };
  const check = async (interactive = true) => {
    if (busy || installingUpdater) return;
    if (!updater) {
      if (interactive)
        await show(
          'Automatic updates are unavailable in this installation. Download a reviewed release manually.',
        );
      return;
    }
    if (ready) {
      await install();
      return;
    }
    busy = true;
    let offeredUpdate = false;
    try {
      if (recreateUpdater) {
        updater = createUpdater();
        recreateUpdater = false;
      }
      available = false;
      const result = await updater.checkForUpdates();
      if (!result || !available) {
        if (interactive) await show('Rajcord is up to date.');
        return;
      }
      offeredUpdate = true;
      const answer = await dialog.showMessageBox({
        type: 'question',
        title: 'Rajcord update',
        message: manifestTrust
          ? 'A new Rajcord version is available.'
          : 'A new Rajcord version is available. Download it now?',
        ...(manifestTrust
          ? {
              detail:
                'Rajcord closes after opening the installer, disconnecting any active voice call.',
            }
          : {}),
        buttons: ['Later', manifestTrust ? 'Download and install' : 'Download'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
      if (manifestTrust) updateProgress(2);
      const files = await updater.downloadUpdate();
      const file = files.length === 1 ? files[0] : undefined;
      const hash = file ? hashFile(file) : undefined;
      const expectedHash = result.updateInfo?.files?.[0]?.sha512;
      if (
        !file ||
        !hash ||
        (manifestTrust
          ? hash !== expectedHash ||
            path.basename(file) !== installerName(result.updateInfo.version)
          : (await verifyUpdateSignature(publishers, file)) !== null)
      )
        throw new Error('Signature verification failed.');
      downloadedFile = file;
      downloadedHash = manifestTrust ? expectedHash : hash;
      ready = true;
    } catch {
      if (!manifestTrust || interactive || offeredUpdate)
        await show(
          'The update check or signature verification failed. No update was installed. Try again later.',
        );
    } finally {
      if (manifestTrust && offeredUpdate) updateProgress(-1);
      busy = false;
    }
    if (ready) await install(manifestTrust !== undefined);
  };
  if (updater) {
    timer = setTimeout(() => {
      void check(false).catch(() => console.error('Automatic update check failed unexpectedly.'));
    }, 30000);
    timer.unref();
    const interval = setInterval(
      () => {
        void check(false).catch(() => console.error('Automatic update check failed unexpectedly.'));
      },
      6 * 60 * 60 * 1000,
    );
    interval.unref();
    app.once('before-quit', () => {
      clearTimeout(timer);
      clearInterval(interval);
    });
  }
  return {
    check: () => check(),
    install: () => install(),
  };
}
