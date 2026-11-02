import { randomUUID } from 'node:crypto';
import type {
  DesktopCaptureCode,
  DesktopPickerAck,
  DesktopPickerSnapshot,
} from '@tricord/shared' with { 'resolution-mode': 'import' };

export type CaptureDocument = {
  webContents: object;
  mainFrame: object;
  url: string;
  navigation: number;
  alive: boolean;
};
export type CaptureOwner = CaptureDocument & {
  authorized: boolean;
  authorizationGeneration: number;
};
// Derived by main from the native Electron request, never from renderer JSON.
export type NativeCaptureRequest = {
  frame: object | null;
  securityOrigin: string;
  videoRequested: boolean;
  audioRequested: boolean;
  userGesture: boolean;
};
export type PickerCaller = { webContents: object; frame: object };
export type CaptureSource = { id: string; name: string };
export type CaptureGrant<T extends CaptureSource> = { video: T; audio?: 'loopback' };
export type CapturePicker = {
  inspect: () => CaptureDocument | null;
  close: () => void;
  ready?: () => void;
};
type Dependencies<T extends CaptureSource> = {
  owner: object;
  targetOrigin: string;
  pickerUrl: string;
  inspectOwner: () => CaptureOwner | null;
  enumerate: (signal: AbortSignal) => Promise<readonly T[]>;
  openPicker: (snapshot: DesktopPickerSnapshot, signal: AbortSignal) => Promise<CapturePicker>;
  onError: (
    code:
      | 'sources_failed'
      | 'picker_failed'
      | 'picker_close_failed'
      | 'callback_failed'
      | 'context_failed',
  ) => void;
  systemAudio?: 'unqualified' | 'qualified-windows-loopback';
  timeoutMs?: number;
  now?: () => number;
};
type Pending<T extends CaptureSource> = {
  id: string;
  document: CaptureOwner;
  expires: number;
  audio: boolean;
  respond: (grant: CaptureGrant<T> | null) => void;
  handles: Map<string, T>;
  picker?: CapturePicker;
  pickerDocument?: CaptureDocument;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
  selecting: boolean;
};
const denied = <T>(code: DesktopCaptureCode): DesktopPickerAck<T> => ({ ok: false, code });
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function record(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === keys.length && keys.every((k) => Object.hasOwn(body, k))
    ? body
    : null;
}
function origin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
function sameDocument(a: CaptureDocument | null, b: CaptureDocument) {
  return (
    !!a?.alive &&
    a.webContents === b.webContents &&
    a.mainFrame === b.mainFrame &&
    a.navigation === b.navigation &&
    a.url === b.url
  );
}

export class DesktopCapturePolicy<T extends CaptureSource> {
  private pending?: Pending<T>;
  private working = false;
  private disposed = false;
  private readonly timeout: number;
  private readonly now: () => number;
  private readonly deps: Dependencies<T>;
  constructor(deps: Dependencies<T>) {
    this.deps = { ...deps };
    this.timeout = deps.timeoutMs ?? 60000;
    this.now = deps.now ?? Date.now;
    if (
      !['http:', 'https:'].includes(new URL(deps.targetOrigin).protocol) ||
      origin(deps.targetOrigin) !== deps.targetOrigin ||
      new URL(deps.pickerUrl).href !== deps.pickerUrl ||
      new URL(deps.pickerUrl).protocol !== 'file:' ||
      !!new URL(deps.pickerUrl).host ||
      !!new URL(deps.pickerUrl).search ||
      !!new URL(deps.pickerUrl).hash ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 2147483647 ||
      !['unqualified', 'qualified-windows-loopback'].includes(deps.systemAudio ?? 'unqualified')
    )
      throw new Error('Invalid desktop capture policy.');
  }
  private inspectOwner() {
    try {
      return this.deps.inspectOwner();
    } catch {
      this.deps.onError('context_failed');
      return null;
    }
  }
  private inspectPicker(picker: CapturePicker) {
    try {
      return picker.inspect();
    } catch {
      this.deps.onError('context_failed');
      return null;
    }
  }
  private ownerDocumentCurrent(p: Pending<T>) {
    const current = this.inspectOwner();
    return (
      !this.disposed &&
      p.expires > this.now() &&
      !!current?.authorized &&
      current.authorizationGeneration === p.document.authorizationGeneration &&
      sameDocument(current, p.document) &&
      current.webContents === this.deps.owner &&
      origin(current.url) === this.deps.targetOrigin
    );
  }
  private ownerCurrent(p: Pending<T>) {
    return !p.finished && this.pending === p && this.ownerDocumentCurrent(p);
  }
  private pickerCurrent(p: Pending<T>) {
    return (
      !!p.pickerDocument &&
      sameDocument(p.picker ? this.inspectPicker(p.picker) : null, p.pickerDocument) &&
      p.pickerDocument.url === this.deps.pickerUrl
    );
  }
  private closePicker(picker: CapturePicker) {
    try {
      picker.close();
      return true;
    } catch {
      this.deps.onError('picker_close_failed');
      return false;
    }
  }
  private finish(p: Pending<T>, grant: CaptureGrant<T> | null = null) {
    if (p.finished) return false;
    p.finished = true;
    clearTimeout(p.timer);
    p.controller.abort();
    p.handles.clear();
    if (this.pending === p) this.pending = undefined;
    if (p.picker && !this.closePicker(p.picker)) grant = null;
    if (grant && !this.ownerDocumentCurrent(p)) grant = null;
    try {
      p.respond(grant);
      return grant !== null;
    } catch {
      this.deps.onError('callback_failed');
      return false;
    }
  }
  private valid(p: Pending<T>, caller: PickerCaller) {
    if (
      !p.pickerDocument ||
      p.pickerDocument.webContents !== caller.webContents ||
      p.pickerDocument.mainFrame !== caller.frame
    )
      return false;
    if (!this.ownerCurrent(p) || !this.pickerCurrent(p)) {
      this.finish(p);
      return false;
    }
    return true;
  }
  private sources(value: readonly T[]): readonly T[] {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 32 ||
      new Set(value.map((s) => s.id)).size !== value.length ||
      value.some(
        (s) =>
          typeof s.id !== 'string' ||
          s.id.length > 256 ||
          !/^(screen|window):\d+:[01]$/.test(s.id) ||
          typeof s.name !== 'string' ||
          s.name.length > 4096,
      )
    )
      throw new Error('Unsupported source list.');
    return value;
  }
  private sounds(p: Pending<T>, source: T): ('none' | 'system')[] {
    return p.audio &&
      source.id.startsWith('screen:') &&
      this.deps.systemAudio === 'qualified-windows-loopback'
      ? ['none', 'system']
      : ['none'];
  }
  private snapshot(p: Pending<T>): DesktopPickerSnapshot {
    return {
      version: 1,
      requestId: p.id,
      remainingMs: Math.max(0, p.expires - this.now()),
      sources: [...p.handles].map(([handle, source]) => ({
        handle,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        label: Array.from(source.name.replace(/[\p{Cc}\p{Cf}]/gu, ''))
          .slice(0, 120)
          .join(''),
        sounds: this.sounds(p, source),
      })),
    };
  }
  begin(
    request: NativeCaptureRequest,
    respond: (grant: CaptureGrant<T> | null) => void,
  ): DesktopPickerAck<{ requestId: string }> {
    this.sweep();
    const document = this.inspectOwner();
    if (
      this.disposed ||
      !document?.alive ||
      !document.authorized ||
      document.webContents !== this.deps.owner ||
      document.mainFrame !== request.frame ||
      !Number.isSafeInteger(document.navigation) ||
      document.navigation < 0 ||
      !Number.isSafeInteger(document.authorizationGeneration) ||
      document.authorizationGeneration < 0 ||
      origin(document.url) !== this.deps.targetOrigin ||
      ![this.deps.targetOrigin, this.deps.targetOrigin + '/'].includes(request.securityOrigin) ||
      request.userGesture !== true ||
      request.videoRequested !== true ||
      typeof request.audioRequested !== 'boolean'
    ) {
      try {
        respond(null);
      } catch {
        this.deps.onError('callback_failed');
      }
      return denied('not_authorized');
    }
    if (this.pending || this.working) {
      try {
        respond(null);
      } catch {
        this.deps.onError('callback_failed');
      }
      return denied('busy');
    }
    const p: Pending<T> = {
      id: randomUUID(),
      document: { ...document },
      expires: this.now() + this.timeout,
      audio: request.audioRequested,
      respond,
      handles: new Map(),
      controller: new AbortController(),
      timer: setTimeout(() => this.finish(p), this.timeout),
      finished: false,
      selecting: false,
    };
    this.pending = p;
    this.working = true;
    void this.prepare(p);
    return { ok: true, data: { requestId: p.id } };
  }
  private async prepare(p: Pending<T>) {
    let phase: 'sources_failed' | 'picker_failed' = 'sources_failed';
    try {
      const sources = this.sources(await this.deps.enumerate(p.controller.signal));
      if (!this.ownerCurrent(p)) {
        this.finish(p);
        return;
      }
      for (const source of sources) p.handles.set(randomUUID(), { ...source });
      phase = 'picker_failed';
      const picker = await this.deps.openPicker(this.snapshot(p), p.controller.signal);
      if (!this.ownerCurrent(p)) {
        this.closePicker(picker);
        this.finish(p);
        return;
      }
      p.picker = picker;
      const document = this.inspectPicker(picker);
      if (
        !document?.alive ||
        document.url !== this.deps.pickerUrl ||
        document.webContents === this.deps.owner ||
        !Number.isSafeInteger(document.navigation) ||
        document.navigation < 0
      ) {
        this.finish(p);
        return;
      }
      p.pickerDocument = { ...document };
      picker.ready?.();
    } catch {
      this.deps.onError(phase);
      this.finish(p);
    } finally {
      this.working = false;
    }
  }
  getSources(caller: PickerCaller): DesktopPickerAck<DesktopPickerSnapshot> {
    const p = this.pending;
    if (!p || !this.valid(p, caller)) return denied('not_authorized');
    if (p.selecting) return denied('busy');
    return { ok: true, data: this.snapshot(p) };
  }
  async select(
    caller: PickerCaller,
    value: unknown,
  ): Promise<DesktopPickerAck<{ selected: true }>> {
    const body = record(value, ['requestId', 'handle', 'sound']);
    if (!body) return denied('invalid');
    const { requestId, handle, sound } = body;
    if (
      !identifier(requestId) ||
      !identifier(handle) ||
      !['none', 'system'].includes(sound as string)
    )
      return denied('invalid');
    const p = this.pending;
    if (!p || !this.valid(p, caller)) return denied('not_authorized');
    if (requestId !== p.id) return denied('stale');
    if (this.working || p.selecting) return denied('busy');
    const source = p.handles.get(handle);
    if (!source) return denied('stale');
    if (!this.sounds(p, source).includes(sound as 'none' | 'system')) return denied('invalid');
    p.selecting = true;
    p.handles.clear();
    this.working = true;
    try {
      const sources = this.sources(await this.deps.enumerate(p.controller.signal));
      if (!this.ownerCurrent(p) || !this.pickerCurrent(p)) {
        this.finish(p);
        return denied('stale');
      }
      const fresh = sources.find((s) => s.id === source.id && s.name === source.name);
      if (!fresh) {
        this.finish(p);
        return denied('stale');
      }
      const granted = this.finish(p, {
        video: fresh,
        ...(sound === 'system' ? { audio: 'loopback' as const } : {}),
      });
      return granted ? { ok: true, data: { selected: true } } : denied('unavailable');
    } catch {
      this.deps.onError('sources_failed');
      this.finish(p);
      return denied('unavailable');
    } finally {
      this.working = false;
    }
  }
  cancel(caller: PickerCaller, value: unknown): DesktopPickerAck<{ cancelled: true }> {
    const body = record(value, ['requestId']);
    if (!body || !identifier(body.requestId)) return denied('invalid');
    const p = this.pending;
    if (!p || !this.valid(p, caller)) return denied('not_authorized');
    if (body.requestId !== p.id) return denied('stale');
    this.finish(p);
    return { ok: true, data: { cancelled: true } };
  }
  // Future main lifecycle hooks call invalidate synchronously on navigation/logout/window loss.
  invalidate() {
    if (this.pending) this.finish(this.pending);
  }
  sweep() {
    if (
      this.pending &&
      (!this.ownerCurrent(this.pending) ||
        (this.pending.picker && !this.pickerCurrent(this.pending)))
    )
      this.finish(this.pending);
  }
  dispose() {
    this.disposed = true;
    this.invalidate();
  }
}
