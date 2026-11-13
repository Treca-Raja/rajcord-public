import { app, autoUpdater as electronAutoUpdater } from 'electron';
import { NsisUpdater } from 'electron-updater';

// Preserve v6's public install/quit contract while letting an error invalidate
// this attempt before its already-queued quit executes. Do not intercept user Quit.
export class RecoverableNsisUpdater extends NsisUpdater {
  constructor(private readonly mayQuit: () => boolean) {
    super();
  }

  override quitAndInstall(isSilent = false, isForceRunAfter = false) {
    const installed = this.install(
      isSilent,
      isSilent ? isForceRunAfter : this.autoRunAppAfterInstall,
    );
    if (!installed) {
      // install() can return false without emitting an error (for example its
      // duplicate-install guard). Release this attempt through the same handler.
      if (this.mayQuit()) this.emit('error', new Error('The update installer did not start.'));
      return;
    }
    setImmediate(() => {
      if (!this.mayQuit()) return;
      electronAutoUpdater.emit('before-quit-for-update');
      app.quit();
    });
  }
}
