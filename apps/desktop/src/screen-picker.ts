import { BrowserWindow, session, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopPickerAck } from '@tricord/shared' with { 'resolution-mode': 'import' };
import type {
  CaptureDocument,
  CapturePicker,
  CaptureSource,
  DesktopCapturePolicy,
} from './screen-capture-policy.js';
import { trustedPickerCaller, PickerIpcBudget } from './picker-ipc-policy.js';

export const screenPickerUrl = pathToFileURL(path.join(__dirname, 'picker/picker.html')).href;
const activePickers = new WeakMap<BrowserWindow, BrowserWindow>();
type PickerPolicy = Pick<
  DesktopCapturePolicy<CaptureSource>,
  'getSources' | 'select' | 'cancel' | 'invalidate'
>;
export async function openScreenPicker({
  owner,
  policy,
  signal,
  visible = true,
}: {
  owner: BrowserWindow;
  policy: PickerPolicy;
  signal: AbortSignal;
  visible?: boolean;
}): Promise<CapturePicker> {
  if (owner.isDestroyed() || signal.aborted) throw new Error('Picker request ended.');
  const existing = activePickers.get(owner);
  if (existing && !existing.isDestroyed()) throw new Error('A source picker is already open.');
  const ownerContents = owner.webContents;
  const isolated = session.fromPartition('rajcord-screen-picker', { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  const assets = ['picker.html', 'picker.css', 'picker.js'].map(
    (name) => pathToFileURL(path.join(__dirname, 'picker', name)).href,
  );
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !assets.includes(details.url) }),
  );
  const win = new BrowserWindow({
    parent: owner,
    modal: true,
    show: false,
    width: 760,
    height: 650,
    minWidth: 540,
    minHeight: 480,
    title: 'Choose a source · Rajcord',
    autoHideMenuBar: true,
    backgroundColor: '#171a20',
    webPreferences: {
      session: isolated,
      preload: path.join(__dirname, 'picker-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  activePickers.set(owner, win);
  const ipc = contents.ipc;
  const invalid: DesktopPickerAck<never> = { ok: false, code: 'invalid' };
  const budget = new PickerIpcBudget();
  let navigation = 0,
    initial = true,
    closed = false,
    bound = false;
  let expected: CaptureDocument | undefined;
  let settleReady!: (value: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    settleReady = resolve;
  });
  const inspect = (): CaptureDocument | null => {
    if (closed || win.isDestroyed() || contents.isDestroyed()) return null;
    const frame = contents.mainFrame;
    if (frame.detached) return null;
    return { webContents: contents, mainFrame: frame, url: frame.url, navigation, alive: true };
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (activePickers.get(owner) === win) activePickers.delete(owner);
    settleReady(false);
    signal.removeEventListener('abort', close);
    owner.removeListener('closed', invalidate);
    ownerContents.removeListener('did-start-navigation', invalidate);
    ownerContents.removeListener('render-process-gone', invalidate);
    for (const channel of ['screen-picker:sources', 'screen-picker:select', 'screen-picker:cancel'])
      ipc.removeHandler(channel);
  };
  const close = () => {
    cleanup();
    if (!win.isDestroyed()) win.destroy();
  };
  const invalidate = () => {
    policy.invalidate();
    close();
  };
  signal.addEventListener('abort', close, { once: true });
  owner.once('closed', invalidate);
  ownerContents.on('did-start-navigation', invalidate);
  ownerContents.once('render-process-gone', invalidate);
  win.on('closed', () => {
    if (!closed) invalidate();
  });
  contents.on('render-process-gone', invalidate);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => {
    event.preventDefault();
    invalidate();
  });
  contents.on('will-redirect', (event) => {
    event.preventDefault();
    invalidate();
  });
  contents.on('did-start-navigation', (event) => {
    navigation++;
    if (!initial || !event.isMainFrame || event.url !== screenPickerUrl) invalidate();
    initial = false;
  });
  const invoke = async <T>(
    event: IpcMainInvokeEvent,
    work: () => T | Promise<T>,
  ): Promise<T | DesktopPickerAck<never>> => {
    if (
      closed ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    )
      return { ok: false, code: 'not_authorized' };
    const release = budget.acquire();
    if (!release) return { ok: false, code: 'busy' };
    try {
      if (
        !(await ready) ||
        !expected ||
        !trustedPickerCaller(expected, inspect(), event.sender, event.senderFrame)
      )
        return { ok: false, code: 'not_authorized' };
      return await work();
    } finally {
      release();
    }
  };
  ipc.handle('screen-picker:sources', (event, ...args: unknown[]) =>
    invoke(event, () =>
      args.length
        ? invalid
        : policy.getSources({ webContents: event.sender, frame: event.senderFrame! }),
    ),
  );
  ipc.handle('screen-picker:select', (event, ...args: unknown[]) =>
    invoke(event, () =>
      args.length !== 1
        ? invalid
        : policy.select({ webContents: event.sender, frame: event.senderFrame! }, args[0]),
    ),
  );
  ipc.handle('screen-picker:cancel', (event, ...args: unknown[]) =>
    invoke(event, () =>
      args.length !== 1
        ? invalid
        : policy.cancel({ webContents: event.sender, frame: event.senderFrame! }, args[0]),
    ),
  );
  try {
    await win.loadURL(screenPickerUrl);
    const document = inspect();
    if (!document || signal.aborted) throw new Error('Picker request ended.');
    expected = document;
    return {
      inspect,
      close,
      ready: () => {
        if (bound || closed) return;
        bound = true;
        settleReady(true);
        if (visible) win.show();
      },
    };
  } catch (cause) {
    close();
    throw cause;
  }
}
