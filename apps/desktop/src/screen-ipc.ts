import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { EventEmitter } from 'node:events';
import type { createSessionCaptureAuthority } from './capture-authority-http.js';

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
}) {
  const { owner, ipc, authority } = options;
  let current: { tag: string; phase: 'preparing' | 'ready' | 'sharing' } | undefined;
  let pending = 0,
    tokens = 12,
    time = Date.now();
  const send = (event: string, value: unknown) => {
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed())
      owner.webContents.send(event, value);
  };
  const invalidated = authority.onInvalidated(() => {
    const previous = current;
    current = undefined;
    if (previous) send('screen:stop', previous.tag);
  });
  const check = (event: IpcMainInvokeEvent) => {
    if (!options.trusted(event)) throw new Error('Untrusted screen request.');
    const now = Date.now();
    tokens = Math.min(12, tokens + Math.max(0, now - time) / 1000);
    time = now;
    if (tokens < 1 || pending >= 2) throw new Error('Screen controls are busy.');
    tokens--;
  };
  ipc.handle('screen:capabilities', (event) => {
    check(event);
    return { version: 1, systemSound: options.systemSound };
  });
  ipc.handle('screen:prepare', async (event, value: unknown) => {
    check(event);
    const request = body(value, ['clientIntentRef', 'epoch', 'sound']);
    if (
      !id(request.clientIntentRef) ||
      !id(request.epoch) ||
      (request.sound !== 'none' && !(request.sound === 'system' && options.systemSound))
    )
      throw new Error('Invalid screen preparation.');
    if (current) throw new Error('Stop the current screen source first.');
    const owned = { tag: request.clientIntentRef, phase: 'preparing' as const };
    current = owned;
    pending++;
    try {
      const intent = await authority.prepare(request.sound as 'none' | 'system', request.epoch);
      if (current !== owned || !options.trusted(event) || authority.inspect() !== intent)
        throw new Error('Screen preparation ended.');
      current = { tag: owned.tag, phase: 'ready' };
      return {
        clientIntentRef: owned.tag,
        ready: true,
        remainingMs: Math.max(0, intent.expires - Date.now()),
      };
    } catch {
      if (current === owned) authority.invalidate();
      return {
        clientIntentRef: owned.tag,
        ready: false,
        remainingMs: 0,
        error: 'Screen preparation failed. Retry after rejoining voice.',
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
      const result = await authority.handoff(request.shareId, request.sourceGeneration as number);
      if (current !== owned || !options.trusted(event)) throw new Error('Screen source ended.');
      current = { tag: owned.tag, phase: 'sharing' };
      return { clientIntentRef: owned.tag, ready: true, remainingMs: result.remainingMs };
    } catch {
      if (current === owned) authority.invalidate();
      return {
        clientIntentRef: owned.tag,
        ready: false,
        remainingMs: 0,
        error: 'Screen publication failed.',
      };
    } finally {
      pending--;
    }
  });
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
    invalidated();
    for (const event of ['show', 'hide', 'minimize', 'restore'])
      lifecycle.removeListener(event, visibility);
    for (const event of ['capabilities', 'prepare', 'handoff', 'cancel'])
      ipc.removeHandler('screen:' + event);
  });
  return Object.freeze({ stop: () => authority.invalidate() });
}
