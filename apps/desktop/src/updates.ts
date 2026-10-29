import { app, dialog } from 'electron';
import type { NsisUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { verifyUpdateSignature } from './update-signature.js';
import { trustedUpdateConfig } from './update-policy.js';
import { RecoverableNsisUpdater } from './update-installer.js';

export function configureUpdates(
  prepareInstall: () => Promise<void>,
  installFailed: () => void = () => {},
) {
  let updater: NsisUpdater | undefined;
  let publishers: string[] = [];
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
      const config = load(
        fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'),
      );
      if (trustedUpdateConfig(config)) {
        publishers = Array.isArray(config.publisherName)
          ? config.publisherName
          : [config.publisherName];
        updater = createUpdater();
      }
    } catch {
      /* Unsigned builds deliberately have no update feed. */
    }
  }
  const install = async () => {
    if (!updater || !ready || busy || installingUpdater) return;
    busy = true;
    let installerCalled = false;
    try {
      const answer = await dialog.showMessageBox({
        type: 'question',
        title: 'Restart Rajcord?',
        message: 'Restart Rajcord to install the verified update?',
        detail: 'This disconnects any active voice call.',
        buttons: ['Later', 'Restart and install'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
      const file = downloadedFile;
      let verified = false;
      try {
        verified =
          !!file &&
          hashFile(file) === downloadedHash &&
          (await verifyUpdateSignature(publishers, file)) === null;
      } catch {
        /* Removed/unreadable cached files cannot be installed. */
      }
      if (!verified) {
        ready = false;
        await show('The update signature could not be verified. Installation was blocked.');
        return;
      }
      await prepareInstall();
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
          'Automatic updates require a signed Rajcord installation. Install a reviewed release manually.',
        );
      return;
    }
    if (ready) {
      await install();
      return;
    }
    busy = true;
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
      const answer = await dialog.showMessageBox({
        type: 'question',
        title: 'Rajcord update',
        message: 'A new Rajcord version is available. Download it now?',
        buttons: ['Later', 'Download'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
      const files = await updater.downloadUpdate();
      if (
        files.length !== 1 ||
        !files[0] ||
        (await verifyUpdateSignature(publishers, files[0])) !== null
      )
        throw new Error('Signature verification failed.');
      downloadedFile = files[0];
      downloadedHash = hashFile(downloadedFile);
      ready = true;
    } catch {
      await show(
        'The update check or signature verification failed. No update was installed. Try again later.',
      );
    } finally {
      busy = false;
    }
    if (ready) await install();
  };
  if (updater) {
    timer = setTimeout(() => {
      void check(false);
    }, 30000);
    timer.unref();
    const interval = setInterval(
      () => {
        void check(false);
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
