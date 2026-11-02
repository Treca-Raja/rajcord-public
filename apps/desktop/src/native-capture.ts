import type { BrowserWindow, Session, Streams, WebFrameMain } from 'electron';
import type { EventEmitter } from 'node:events';
import {
  DesktopCapturePolicy,
  type CapturePicker,
  type CaptureSource,
} from './screen-capture-policy.js';
import { openScreenPicker, screenPickerUrl } from './screen-picker.js';
import type { DesktopPickerSnapshot } from '@tricord/shared' with { 'resolution-mode': 'import' };

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
type DisplayHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>;
export type NativeCapturePermissions = { request: RequestHandler; check: CheckHandler };
// Main-owned authority only. A renderer flag, reference ID, or unverified lease is not this authority.
export type TrustedCaptureIntent = Readonly<{
  intent: object;
  authorization: object;
  generation: number;
  expires: number;
  frame: WebFrameMain;
  url: string;
  navigation: number;
  sound: 'none' | 'system';
}>;
export type CaptureIntentSource = {
  inspect: () => TrustedCaptureIntent | null;
  verify: (intent: TrustedCaptureIntent) => Promise<boolean>;
  onInvalidated: (listener: () => void) => () => void;
};
export type NativeCaptureSource = CaptureSource & { video: NonNullable<Streams['video']> };
type Options = {
  owner: BrowserWindow;
  session: Session;
  targetOrigin: string;
  permissions: NativeCapturePermissions;
  enabled?: boolean;
  qualification?: 'unqualified' | 'qualified-native-provider' | 'synthetic-webcontents';
  systemAudio?: 'unqualified' | 'qualified-windows-loopback';
  authority?: CaptureIntentSource;
  enumerate?: (signal: AbortSignal) => Promise<readonly NativeCaptureSource[]>;
  openPicker?: (
    snapshot: DesktopPickerSnapshot,
    signal: AbortSignal,
    policy: DesktopCapturePolicy<NativeCaptureSource>,
  ) => Promise<CapturePicker>;
  shutdown?: Pick<EventEmitter, 'on' | 'removeListener'>;
  onError: (code: string) => void;
  now?: () => number;
};
const installed = new WeakSet<Session>();
const sameOrigin = (value: string, target: string) => value === target || value === target + '/';

export function installNativeCapture(configuration: Options) {
  const options = { ...configuration, permissions: { ...configuration.permissions } };
  const { owner, session, targetOrigin, permissions, onError } = options;
  if (installed.has(session)) throw new Error('Capture boundary already owns this session.');
  if (
    new URL(targetOrigin).origin !== targetOrigin ||
    !['http:', 'https:'].includes(new URL(targetOrigin).protocol) ||
    owner.webContents.session !== session
  )
    throw new Error('Invalid native capture owner/session/origin.');
  installed.add(session);
  const contents = owner.webContents,
    now = options.now ?? Date.now;
  const used = new WeakSet<object>();
  let navigation = 0,
    disposed = false,
    authorityBroken = false;
  let verifying = false;
  let denyActive = () => {};
  let active:
    | {
        intent: TrustedCaptureIntent;
        respond: (streams: Streams | null) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const enabled =
    options.enabled === true &&
    !!options.authority &&
    typeof options.authority.verify === 'function' &&
    !!options.enumerate &&
    ['qualified-native-provider', 'synthetic-webcontents'].includes(
      options.qualification ?? 'unqualified',
    );
  const inspectAuthority = () => {
    if (!enabled || authorityBroken || disposed) return null;
    try {
      return options.authority!.inspect();
    } catch {
      authorityBroken = true;
      onError('authority_unavailable');
      denyActive();
      return null;
    }
  };
  const document = () => {
    try {
      if (disposed || owner.isDestroyed() || contents.isDestroyed()) return null;
      const frame = contents.mainFrame;
      if (frame.detached) return null;
      return { webContents: contents, mainFrame: frame, url: frame.url, navigation, alive: true };
    } catch {
      onError('native_context_unavailable');
      return null;
    }
  };
  const valid = (intent: TrustedCaptureIntent | null): intent is TrustedCaptureIntent => {
    const doc = document();
    return (
      !!intent &&
      !!doc &&
      typeof intent.intent === 'object' &&
      intent.intent !== null &&
      typeof intent.authorization === 'object' &&
      intent.authorization !== null &&
      Number.isSafeInteger(intent.generation) &&
      intent.generation > 0 &&
      Number.isSafeInteger(intent.expires) &&
      intent.expires > now() &&
      intent.frame === doc.mainFrame &&
      intent.url === doc.url &&
      intent.navigation === doc.navigation &&
      doc.url.startsWith(targetOrigin + '/') &&
      (intent.sound === 'none' ||
        (intent.sound === 'system' && options.systemAudio === 'qualified-windows-loopback'))
    );
  };
  const current = () => {
    const intent = inspectAuthority();
    if (!valid(intent)) {
      if (active) denyActive();
      return null;
    }
    if (!active) return used.has(intent.intent) ? null : intent;
    const expected = active.intent;
    const matches =
      intent.intent === expected.intent &&
      intent.authorization === expected.authorization &&
      intent.generation === expected.generation &&
      intent.frame === expected.frame &&
      intent.url === expected.url &&
      intent.navigation === expected.navigation &&
      intent.sound === expected.sound &&
      Math.min(expected.expires, intent.expires) > now();
    if (!matches) {
      denyActive();
      return null;
    }
    return intent;
  };
  const policy: DesktopCapturePolicy<NativeCaptureSource> =
    new DesktopCapturePolicy<NativeCaptureSource>({
      owner: contents,
      targetOrigin,
      pickerUrl: screenPickerUrl,
      inspectOwner: () => {
        const doc = document(),
          intent = current();
        return doc
          ? {
              ...doc,
              authorized: !!intent && !!active,
              authorizationGeneration: intent?.generation ?? 0,
            }
          : null;
      },
      enumerate: (signal) => options.enumerate!(signal),
      openPicker: (snapshot, signal): Promise<CapturePicker> =>
        options.openPicker
          ? options.openPicker(snapshot, signal, policy)
          : openScreenPicker({ owner, policy, signal }),
      systemAudio: options.systemAudio ?? 'unqualified',
      onError,
      now,
    });
  const invalidate = () => {
    policy.invalidate();
    if (active) active.respond(null);
  };
  denyActive = invalidate;
  const baseRequest: RequestHandler = (wc, permission, callback, details) => {
    if (
      permission === 'display-capture' ||
      (permission === 'media' &&
        (!('mediaTypes' in details) ||
          details.mediaTypes?.length !== 1 ||
          details.mediaTypes[0] !== 'audio'))
    ) {
      callback(false);
      return;
    }
    permissions.request(wc, permission, callback, details);
  };
  const baseCheck: CheckHandler = (wc, permission, origin, details) =>
    permission !== 'display-capture' &&
    !(permission === 'media' && details.mediaType !== 'audio') &&
    permissions.check(wc, permission, origin, details);
  const permission = (
    wc: Parameters<CheckHandler>[0],
    main: boolean,
    url: string | undefined,
    origin?: string,
  ) => {
    const intent = current();
    return (
      !!intent &&
      wc === contents &&
      main === true &&
      (url === undefined || url === intent.url) &&
      (origin === undefined || sameOrigin(origin, targetOrigin))
    );
  };
  const request: RequestHandler = (wc, name, callback, details) => {
    if (name !== 'display-capture') {
      baseRequest(wc, name, callback, details);
      return;
    }
    callback(permission(wc, details.isMainFrame, details.requestingUrl));
  };
  const check: CheckHandler = (wc, name, origin, details) =>
    name === 'display-capture'
      ? permission(wc, details.isMainFrame, details.requestingUrl, origin)
      : baseCheck(wc, name, origin, details);
  const display: DisplayHandler = (request, callback) => {
    let settled = false;
    const respond = (streams: Streams | null) => {
      if (settled) return;
      settled = true;
      if (active?.respond === respond) {
        clearTimeout(active.timer);
        active = undefined;
      }
      try {
        callback(streams);
      } catch {
        onError('native_callback_failed');
      }
    };
    const intent = current(),
      doc = document();
    if (
      active ||
      verifying ||
      !intent ||
      !doc ||
      used.has(intent.intent) ||
      request.frame !== doc.mainFrame ||
      !sameOrigin(request.securityOrigin, targetOrigin) ||
      request.userGesture !== true ||
      request.videoRequested !== true ||
      request.audioRequested !== (intent.sound === 'system')
    ) {
      respond(null);
      return;
    }
    used.add(intent.intent);
    active = {
      intent: { ...intent },
      respond,
      timer: setTimeout(invalidate, Math.min(60000, Math.max(1, intent.expires - now()))),
    };
    try {
      policy.begin(request, (grant) => {
        if (
          !grant ||
          !current() ||
          active?.respond !== respond ||
          (intent.sound === 'system' && grant.audio !== 'loopback')
        ) {
          respond(null);
          return;
        }
        verifying = true;
        void (async () => {
          if (
            !(await options.authority!.verify(intent)) ||
            !current() ||
            active?.respond !== respond
          ) {
            respond(null);
            return;
          }
          const video = grant.video.video;
          if (
            !video ||
            ('detached' in video && video.detached) ||
            ('id' in video && (video.id !== grant.video.id || video.name !== grant.video.name))
          ) {
            respond(null);
            return;
          }
          respond({ video, ...(grant.audio ? { audio: grant.audio } : {}) });
        })()
          .catch(() => {
            onError('native_authority_unavailable');
            respond(null);
          })
          .finally(() => {
            verifying = false;
          });
      });
    } catch {
      onError('native_request_failed');
      policy.invalidate();
      respond(null);
    }
  };
  session.setPermissionRequestHandler(request);
  session.setPermissionCheckHandler(check);
  session.setDisplayMediaRequestHandler(display, { useSystemPicker: false });
  let unsubscribe = () => {};
  try {
    unsubscribe = options.authority?.onInvalidated(invalidate) ?? unsubscribe;
  } catch {
    authorityBroken = true;
    onError('authority_unavailable');
    invalidate();
  }
  const navigate = () => {
    navigation++;
    invalidate();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    invalidate();
    policy.dispose();
    try {
      unsubscribe();
    } catch {
      onError('authority_unsubscribe_failed');
    }
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('render-process-gone', invalidate);
    owner.removeListener('closed', dispose);
    options.shutdown?.removeListener('before-quit', invalidate);
    options.shutdown?.removeListener('will-quit', dispose);
    session.setDisplayMediaRequestHandler((_request, callback) => callback(null), {
      useSystemPicker: false,
    });
    session.setPermissionRequestHandler(baseRequest);
    session.setPermissionCheckHandler(baseCheck);
    installed.delete(session);
  };
  contents.on('did-start-navigation', navigate);
  contents.on('render-process-gone', invalidate);
  owner.once('closed', dispose);
  options.shutdown?.on('before-quit', invalidate);
  options.shutdown?.on('will-quit', dispose);
  return { invalidate, dispose, context: document };
}
