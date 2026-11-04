import fs from 'node:fs';
import path from 'node:path';
import type { Session, WebContents } from 'electron';
import { trustedAudioCheck, trustedAudioRequest } from './media-permissions.js';

type ConsentOptions = {
  profileDirectory: string;
  target: string;
  ask: () => Promise<boolean>;
  onError: (message: string) => void;
};
export class MicrophonePermission {
  private granted = false;
  private pending?: Promise<boolean>;
  private revision = 0;
  private readonly file: string;
  private readonly origin: string;
  constructor(private readonly options: ConsentOptions) {
    this.file = path.join(options.profileDirectory, 'microphone-permission.json');
    this.origin = new URL(options.target).origin;
    try {
      let raw: string;
      try {
        raw = fs.readFileSync(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const saved: unknown = JSON.parse(raw);
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('version' in saved) ||
        saved.version !== 1 ||
        !('origin' in saved) ||
        typeof saved.origin !== 'string' ||
        !('microphone' in saved) ||
        saved.microphone !== true
      )
        throw new Error('Invalid microphone permission record.');
      this.granted = saved.origin === this.origin;
    } catch {
      options.onError(
        'Saved microphone permission could not be read. Approve microphone access again; no access has been granted.',
      );
    }
  }
  get allowed() {
    return this.granted;
  }
  request(): Promise<boolean> {
    if (this.granted) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const revision = this.revision;
    const pending = this.askAndRemember(revision).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async askAndRemember(revision: number) {
    let approved: boolean;
    try {
      approved = await this.options.ask();
    } catch {
      if (revision === this.revision)
        this.options.onError('Microphone permission could not be requested. Try again.');
      return false;
    }
    if (!approved || revision !== this.revision) return false;
    try {
      fs.mkdirSync(this.options.profileDirectory, { recursive: true });
      const temporary = this.file + '.tmp';
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: 1, origin: this.origin, microphone: true }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, this.file);
    } catch {
      this.options.onError(
        'Microphone permission could not be saved. Access remains blocked; check app data storage and try again.',
      );
      return false;
    }
    this.granted = true;
    return true;
  }
  reset() {
    this.revision++;
    this.granted = false;
    try {
      fs.unlinkSync(this.file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      this.options.onError(
        'Microphone access was reset for this run, but saved approval could not be removed. Check app data storage before restarting.',
      );
      return false;
    }
  }
}

export function installMicrophonePermissions(
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  contents: WebContents,
  target: string,
  permission: Pick<MicrophonePermission, 'allowed' | 'request'>,
) {
  session.setPermissionRequestHandler((requester, kind, callback, details) => {
    if (
      requester !== contents ||
      !trustedAudioRequest(
        target,
        details.requestingUrl,
        details.isMainFrame,
        kind,
        'mediaTypes' in details ? details.mediaTypes : undefined,
      )
    ) {
      callback(false);
      return;
    }
    void permission.request().then((allowed) => {
      callback(
        allowed &&
          permission.allowed &&
          !contents.isDestroyed() &&
          trustedAudioCheck(target, contents.getURL(), true, 'media', 'audio'),
      );
    });
  });
  session.setPermissionCheckHandler(
    (requester, kind, origin, details) =>
      requester === contents &&
      permission.allowed &&
      trustedAudioCheck(target, origin, details.isMainFrame, kind, details.mediaType),
  );
}
