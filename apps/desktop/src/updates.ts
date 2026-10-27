import { app, dialog } from 'electron';
import { NsisUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { verifyUpdateSignature } from './update-signature.js';
import { trustedUpdateConfig } from './update-policy.js';

export function configureUpdates(prepareInstall: () => Promise<void>) {
  let updater: NsisUpdater | undefined;
  let publishers: string[] = [];
  let busy = false;
  let ready = false;
  let downloadedFile: string | undefined;
  let downloadedHash: string | undefined;
  const hashFile = (file: string) =>
    createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  let available = false;
  let timer: NodeJS.Timeout | undefined;
  const show = (message: string) =>
    dialog.showMessageBox({ type: 'info', title: 'Rajcord updates', message });
  if (app.isPackaged && process.platform === 'win32') {
    try {
      const config = load(
        fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'),
      );
      if (trustedUpdateConfig(config)) {
        publishers = Array.isArray(config.publisherName)
          ? config.publisherName
          : [config.publisherName];
        updater = new NsisUpdater();
        updater.verifyUpdateCodeSignature = verifyUpdateSignature;
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        updater.disableWebInstaller = true;
        updater.logger = null; // Do not log URLs, downloaded metadata or profiles.
        updater.on('error', () => {
          ready = false;
        });
        updater.on('update-available', () => {
          available = true;
        });
      }
    } catch {
      /* Unsigned builds deliberately have no update feed. */
    }
  }
  const install = async () => {
    if (!updater || !ready || busy) return;
    busy = true;
    const answer = await dialog.showMessageBox({
      type: 'question',
      title: 'Restart Rajcord?',
      message: 'Restart Rajcord to install the verified update?',
      detail: 'This disconnects any active voice call.',
      buttons: ['Later', 'Restart and install'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response === 1) {
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
        busy = false;
        await show('The update signature could not be verified. Installation was blocked.');
        return;
      }
      await prepareInstall();
      updater.quitAndInstall(false, true);
    }
    busy = false;
  };
  const check = async (interactive = true) => {
    if (busy) return;
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
