import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { EventEmitter } from 'node:events';
import type { createSessionCaptureAuthority } from './capture-authority-http.js';
import type { TrustedCaptureIntent } from './native-capture.js';
import { ObsScreen, obsEncoders, type obsRuntime } from './obs-screen.js';
import type {
  DESKTOP_SCREEN_PROTOCOL_VERSION,
  NativeScreenCommand,
  ObsEncoderChoice,
} from '@tricord/shared' with { 'resolution-mode': 'import' };

const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function body(value: unknown, fields: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('Invalid screen request.');
  return value as Record<string, unknown>;
}
export function installScreenIpc(options: {
  owner: BrowserWindow;
  ipc: IpcMain;
  authority: ReturnType<typeof createSessionCaptureAuthority>;
  trusted(event: IpcMainInvokeEvent): boolean;
  systemSound: boolean;
  applicationSound?: boolean;
  obs: ReturnType<typeof obsRuntime>;
  target(intent: TrustedCaptureIntent): string[];
}) {
  const { owner, ipc, authority } = options;
  let current:
    | {
        tag: string;
        phase: 'preparing' | 'ready' | 'sharing';
        encoder: ObsEncoderChoice;
      }
    | undefined;
  let native: ObsScreen | undefined;
  let retiring: ObsScreen['stopped'] | undefined;
  let nativeError: string | undefined;
  let pending = 0,
    tokens = 12,
    time = Date.now();
  const send = (event: string, ...values: unknown[]) => {
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed())
      owner.webContents.send(event, ...values);
  };
  const retireNative = () => {
    const process = native;
    if (!process) return;
    native = undefined;
    process.stop();
    retiring = process.stopped;
  };
  const invalidated = authority.onInvalidated(() => {
    const previous = current;
    retireNative();
    current = undefined;
    if (previous) {
      if (nativeError) send('screen:stop', previous.tag, nativeError);
      else send('screen:stop', previous.tag);
    }
    nativeError = undefined;
  });
  const check = (event: IpcMainInvokeEvent) => {
    if (!options.trusted(event)) throw new Error('Untrusted screen request.');
    const now = Date.now();
    tokens = Math.min(12, tokens + Math.max(0, now - time) / 1000);
    time = now;
    if (tokens < 1 || pending >= 2) throw new Error('Screen controls are busy.');
    tokens--;
  };
  const runtime = options.obs;
  let obsProbe: ReturnType<typeof obsEncoders> | undefined;
  const probe = () => {
    if (!runtime.available) return Promise.reject(new Error(runtime.reason));
    return (obsProbe ??= obsEncoders(runtime).then(
      (encoders) => {
        if (!encoders.length) obsProbe = undefined;
        return encoders;
      },
      (error: unknown) => {
        obsProbe = undefined;
        throw error;
      },
    ));
  };
  const noEncoder = 'OBS could not initialize an encoder. Update your graphics driver and retry.';
  ipc.handle('screen:capabilities', async (event) => {
    check(event);
    const obs = await probe().then(
      (encoders) => ({
        available: encoders.length > 0,
        encoders,
        ...(encoders.length ? {} : { reason: noEncoder }),
      }),
      (error: Error) => ({ available: false, encoders: [], reason: error.message }),
    );
    return {
      version: 2 satisfies typeof DESKTOP_SCREEN_PROTOCOL_VERSION,
      obs,
      systemSound: options.systemSound,
      sourceSound: options.systemSound,
      ...(options.applicationSound ? { applicationSound: true } : {}),
    };
  });
  ipc.handle('screen:prepare', async (event, value: unknown) => {
    check(event);
    const request = body(value, ['clientIntentRef', 'epoch', 'sound', 'encoder']);
    if (
      !id(request.clientIntentRef) ||
      !id(request.epoch) ||
      !['auto', 'nvenc', 'amf', 'x264'].some((value) => value === request.encoder) ||
      (request.sound !== 'none' &&
        !(request.sound === 'system' && options.systemSound) &&
        !(request.sound === 'application' && options.applicationSound) &&
        !(request.sound === 'source' && options.systemSound))
    )
      throw new Error('Invalid screen preparation.');
    if (current) throw new Error('Stop the current screen source first.');
    const owned = {
      tag: request.clientIntentRef,
      phase: 'preparing' as const,
      encoder: request.encoder as ObsEncoderChoice,
    };
    current = owned;
    pending++;
    try {
      const available = await probe();
      if (!available.length) throw new Error(noEncoder);
      if (owned.encoder !== 'auto' && !available.includes(owned.encoder))
        throw new Error('The selected OBS encoder is unavailable. Choose Automatic and retry.');
      if (current !== owned || !options.trusted(event))
        throw new Error('Screen preparation ended.');
      const intent = await authority.prepare(
        request.sound as 'none' | 'system' | 'application' | 'source',
        request.epoch,
      );
      if (current !== owned || !options.trusted(event) || authority.inspect() !== intent)
        throw new Error('Screen preparation ended.');
      current = { ...owned, phase: 'ready' };
      return {
        clientIntentRef: owned.tag,
        ready: true,
        remainingMs: Math.max(0, intent.expires - Date.now()),
      };
    } catch (error) {
      if (current === owned) authority.invalidate();
      return {
        clientIntentRef: owned.tag,
        ready: false,
        remainingMs: 0,
        error: error instanceof Error ? error.message : 'Screen preparation failed.',
      };
    } finally {
      pending--;
    }
  });
  ipc.handle('screen:handoff', async (event, value: unknown) => {
    check(event);
    const request = body(value, ['clientIntentRef', 'shareId', 'sourceGeneration']);
    const owned = current;
    if (
      !owned ||
      request.clientIntentRef !== owned.tag ||
      owned.phase !== 'ready' ||
      !id(request.shareId) ||
      !Number.isSafeInteger(request.sourceGeneration) ||
      (request.sourceGeneration as number) < 1
    )
      throw new Error('Screen source ended.');
    pending++;
    try {
      if (!runtime.available) throw new Error(runtime.reason);
      const previous = retiring;
      if (previous) {
        await previous;
        if (retiring === previous) retiring = undefined;
      }
      const { NATIVE_VIEWER_GRANT_BATCH_SIZE } = await import('@tricord/shared');
      if (current !== owned || !options.trusted(event)) throw new Error('Screen source ended.');
      const intent = authority.inspect();
      if (!intent) throw new Error('The OBS screen source ended.');
      const target = options.target(intent);
      const result = await authority.handoff(
        request.shareId,
        request.sourceGeneration as number,
        true,
      );
      if (current !== owned || !options.trusted(event)) throw new Error('Screen source ended.');
      const process = new ObsScreen(
        runtime,
        owned.tag,
        (event) => send('screen:native-event', event),
        (reason) => {
          if (native !== process) return;
          nativeError = reason;
          authority.invalidate();
        },
        NATIVE_VIEWER_GRANT_BATCH_SIZE,
        owned.encoder,
      );
      native = process;
      authority.observeNativeViewers((snapshot, started) => process.observe(snapshot, started));
      await process.start(target);
      if (current !== owned || !options.trusted(event) || !authority.inspectPublication())
        throw new Error('Screen source ended.');
      current = { ...owned, phase: 'sharing' };
      return { clientIntentRef: owned.tag, ready: true, remainingMs: result.remainingMs };
    } catch (error) {
      if (current === owned) authority.invalidate();
      return {
        clientIntentRef: owned.tag,
        ready: false,
        remainingMs: 0,
        error: error instanceof Error ? error.message : 'Screen publication failed.',
      };
    } finally {
      pending--;
    }
  });
  {
    let inFlight = 0;
    let balance = 160;
    let updated = performance.now();
    ipc.handle('screen:native-command', async (event, value: unknown) => {
      if (
        !options.trusted(event) ||
        current?.phase !== 'sharing' ||
        !native ||
        !value ||
        typeof value !== 'object' ||
        !authority.inspectPublication()
      )
        throw new Error('OBS screen publication ended.');
      const command = value as NativeScreenCommand;
      if (command.op === 'close') return native.command(command);
      const now = performance.now();
      balance = Math.min(160, balance + (now - updated) / 50);
      updated = now;
      if (balance < 1 || inFlight >= 32) throw new Error('Native screen controls are busy.');
      balance--;
      inFlight++;
      try {
        return await native.command(command);
      } finally {
        inFlight--;
      }
    });
  }
  ipc.handle('screen:cancel', (event, value: unknown) => {
    // Cancellation has a separate bounded payload and always remains available locally.
    if (!options.trusted(event)) throw new Error('Untrusted screen cancellation.');
    const request = body(value, ['clientIntentRef']);
    if (!id(request.clientIntentRef)) throw new Error('Invalid screen cancellation.');
    if (current?.tag === request.clientIntentRef) authority.invalidate();
  });
  const visibility = () => send('screen:visibility', owner.isVisible() && !owner.isMinimized());
  const lifecycle = owner as EventEmitter;
  for (const event of ['show', 'hide', 'minimize', 'restore']) lifecycle.on(event, visibility);
  owner.once('closed', () => {
    retireNative();
    invalidated();
    for (const event of ['show', 'hide', 'minimize', 'restore'])
      lifecycle.removeListener(event, visibility);
    for (const event of ['capabilities', 'prepare', 'handoff', 'cancel', 'native-command'])
      ipc.removeHandler('screen:' + event);
  });
  return Object.freeze({
    stop: () => authority.invalidate(),
  });
}
