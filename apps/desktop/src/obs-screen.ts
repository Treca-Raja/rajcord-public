import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openTurnTls } from './obs-turn-tls.js';
import { NativeViewerGrants, nativeLinkId } from './native-viewer-grants.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NativeCaptureSource } from './native-capture.js';
import type { Screen } from 'electron';
import type {
  NativeScreenCommand,
  NativeScreenEvent,
  NativeScreenVideo,
  NativeViewerSnapshot,
  ObsEncoder,
  ObsEncoderChoice,
  ScreenIceServer,
} from '@tricord/shared' with { 'resolution-mode': 'import' };

const maxLine = 20000;
const encode = (value: string) => Buffer.from(value).toString('base64');
const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');
const sourceEnded = () => new Error('The OBS screen source ended.');

export function nativeCaptureIdentity(
  source: NativeCaptureSource,
  target: string[],
  displayRevision: number,
) {
  if (source.id.startsWith('screen:') && 'display_id' in source.video)
    return JSON.stringify([source.video.display_id, displayRevision, ...target]);
  return JSON.stringify(target);
}

export function obsTarget(
  source: NativeCaptureSource,
  desktop: Screen,
  sound: 'none' | 'application' | 'system' | 'source' = 'none',
): string[] {
  const window = /^window:([1-9]\d{0,19}):[01]$/.exec(source.id);
  if (window) {
    const target = ['window', window[1]!];
    const identity = /^([1-9]\d{0,9}):([1-9]\d{0,18})$/.exec(source.applicationIdentity ?? '');
    if (
      sound === 'system' ||
      !identity ||
      source.applicationAudioId !== 'applicationLoopback:' + identity[1] ||
      Number(identity[1]) > 0xffffffff ||
      Number(identity[1]) === process.pid
    )
      throw new Error('The selected window process identity is unavailable.');
    return sound === 'none'
      ? [...target, 'identity', identity[1]!, identity[2]!]
      : [...target, 'app', identity[1]!, identity[2]!, String(process.pid)];
  }
  if (source.id.startsWith('screen:') && 'display_id' in source.video) {
    const displayId = source.video.display_id;
    const display = desktop.getAllDisplays().find(({ id }) => String(id) === displayId);
    if (display) {
      const { x, y, width, height } = desktop.dipToScreenRect(null, display.bounds);
      if (sound === 'application') throw new Error('Choose a window for application audio.');
      return [
        'monitor',
        ...[x, y, x + width, y + height].map(String),
        ...(sound === 'none' ? [] : ['system', String(process.pid)]),
      ];
    }
  }
  throw new Error('OBS could not identify the source selected in the Rajcord picker.');
}

export function obsRuntime(packaged: boolean, fixtureBundle?: string) {
  if (process.platform !== 'win32')
    return { available: false as const, reason: 'Desktop screen sharing requires Windows.' };
  const root = packaged
    ? path.join(process.resourcesPath, 'obs-screen')
    : fixtureBundle
      ? path.resolve(fixtureBundle)
      : path.resolve(__dirname, '../native/obs/dist/bundle');
  const executable = path.join(root, 'bin', 'rajcord-obs.exe');
  if (
    !existsSync(executable) ||
    !['obs.dll', 'datachannel.dll'].every((file) => existsSync(path.join(root, 'bin', file)))
  )
    return {
      available: false as const,
      reason: packaged
        ? 'Rajcord’s OBS files are missing. Reinstall Rajcord Desktop to restore screen sharing.'
        : 'Rajcord’s OBS helper is missing. Run pnpm desktop:obs:setup to build and stage it.',
    };
  return { available: true as const, root, executable };
}

type NativeRuntime = Extract<ReturnType<typeof obsRuntime>, { available: true }>;
function nativeEnvironment(root: string, encoder?: ObsEncoderChoice) {
  const bin = path.join(root, 'bin');
  const system = process.env.SystemRoot || 'C:\\Windows';
  return {
    SystemRoot: system,
    PATH: [bin, path.join(system, 'System32')].join(path.delimiter),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ...(encoder ? { RAJCORD_OBS_ENCODER: encoder } : {}),
  };
}
export function obsEncoders(runtime: NativeRuntime): Promise<ObsEncoder[]> {
  return new Promise((resolve, reject) => {
    execFile(
      runtime.executable,
      ['--probe'],
      {
        cwd: path.join(runtime.root, 'bin'),
        env: nativeEnvironment(runtime.root),
        timeout: 15000,
        maxBuffer: 4096,
        windowsHide: true,
      },
      (error, output) => {
        if (error)
          reject(
            new Error(
              'OBS could not initialize. Update your graphics driver or reinstall Rajcord Desktop.',
            ),
          );
        else
          resolve(
            (['nvenc', 'amf', 'x264'] as const).filter((encoder) =>
              output.split(/\r?\n/).includes(encoder),
            ),
          );
      },
    );
  });
}
function video(value: NativeScreenVideo) {
  const limits = [
    [value?.width, 160, 4096],
    [value?.height, 64, 1080],
    [value?.fps, 1, 60],
    [value?.bitrate, 100000, 20000000],
  ] as const;
  if (
    limits.some(
      ([number, min, max]) => !Number.isInteger(number) || number < min || number > max,
    ) ||
    value.width % 2 ||
    value.height % 2
  )
    throw new Error('Invalid OBS video limits.');
  return [value.width, value.height, value.fps, value.bitrate].map(String);
}

export function obsIce(servers: ScreenIceServer[]) {
  if (!Array.isArray(servers) || servers.length > 4) throw new Error('Invalid native ICE servers.');
  const uris: string[] = [];
  const secure: { host: string; port: number; credentials: string }[] = [];
  for (const server of servers) {
    if (!Array.isArray(server?.urls) || !server.urls.length || server.urls.length > 4)
      throw new Error('Invalid native ICE server.');
    for (const value of server.urls) {
      const url = /^(stun|turns?):([a-z0-9][a-z0-9.-]*):(\d{1,5})(\?transport=(udp|tcp))?$/.exec(
        value,
      );
      if (!url || typeof value !== 'string') throw new Error('Invalid native ICE URL.');
      const [, scheme, host, port, query] = url;
      if (!host || !port || Number(port) < 1 || Number(port) > 65535)
        throw new Error('Invalid native ICE endpoint.');
      if (scheme === 'stun') {
        if (query || server.username || server.credential)
          throw new Error('Invalid native STUN URL.');
        if (!uris.some((uri) => uri.startsWith('stun://'))) uris.push(`stun://${host}:${port}`);
      } else {
        if (
          typeof server.username !== 'string' ||
          !/^(?:[A-Za-z0-9]{8,256}|\d{1,12}\.[a-f0-9]{32})$/.test(server.username) ||
          typeof server.credential !== 'string' ||
          !/^(?:[A-Za-z0-9]{8,128}|[A-Za-z0-9+/]{27}=)$/.test(server.credential) ||
          (scheme === 'turns' && query === '?transport=udp')
        )
          throw new Error('Invalid native TURN credentials.');
        const credentials = `${server.username}:${encodeURIComponent(server.credential)}`;
        if (scheme === 'turns') secure.push({ host, port: Number(port), credentials });
        else uris.push(`turn://${credentials}@${host}:${port}${query ?? ''}`);
      }
    }
  }
  if (secure.length > 1) throw new Error('Expected one native TURN/TLS endpoint.');
  return { uris, secure: secure[0] };
}

export class ObsScreen {
  private readonly child;
  readonly stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private links = new Map<string, ReturnType<typeof setTimeout>>();
  private line = '';
  private closed = false;
  private grants: NativeViewerGrants;
  private ice: ReturnType<typeof obsIce> = { uris: [], secure: undefined };
  private turnTls = new Map<string, Awaited<ReturnType<typeof openTurnTls>>>();
  private offers = new Map<string, string>();
  private generations = new Map<string, { opening: boolean }>();
  private closing = new Set<string>();
  observe(snapshot: NativeViewerSnapshot, started: number) {
    if (this.closed) return;
    this.ice = obsIce(snapshot.iceServers);
    this.grants.observe(snapshot, started);
    for (const id of this.links.keys()) {
      const deadline = this.grants.currentDeadline(id);
      if (deadline) this.lease(id, deadline);
      else
        void this.closeLink(id).catch(() => this.fail('Could not stop the revoked native viewer.'));
    }
  }
  private sound = false;

  constructor(
    runtime: NativeRuntime,
    private readonly tag: string,
    private readonly event: (event: NativeScreenEvent) => void,
    private readonly ended: (reason: string) => void,
    private readonly viewerBatchSize: number,
    obsEncoder?: ObsEncoderChoice,
    diagnosticOutput?: (chunk: string) => void,
    loopbackRelayFixture = false,
  ) {
    this.grants = new NativeViewerGrants(viewerBatchSize);
    const bin = path.join(runtime.root, 'bin');
    this.child = spawn(runtime.executable, [], {
      shell: false,
      windowsHide: true,
      cwd: bin,
      env: {
        ...nativeEnvironment(runtime.root, obsEncoder),
        ...(diagnosticOutput ? { RAJCORD_OBS_DIAGNOSTICS: '1' } : {}),
        ...(loopbackRelayFixture ? { RAJCORD_NATIVE_TEST_RELAY: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stopped = new Promise((resolve) =>
      this.child.once('close', (code, signal) => resolve({ code, signal })),
    );
    if (diagnosticOutput) this.child.stderr.setEncoding('utf8').on('data', diagnosticOutput);
    else this.child.stderr.resume();
    this.child.on('error', () => this.fail('Could not launch the native screen helper.'));
    this.child.once('exit', () => this.fail('The native screen helper exited.'));
    this.child.stdin.on('error', () => this.fail('The native screen helper stopped responding.'));
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.read(chunk));
  }

  private read(chunk: string) {
    if (this.closed) return;
    const lines = (this.line + chunk).split('\n');
    this.line = lines.pop()!;
    if (this.line.length > maxLine || lines.some((line) => line.length > maxLine)) {
      this.fail('The native screen helper returned an oversized response.');
      return;
    }
    for (const line of lines) {
      const [type, id, data, extra] = line.trimEnd().split('\t');
      if (type === 'FATAL' && id) {
        this.fail(decode(id));
        return;
      }
      if (!id) continue;
      if (type === 'OK' || type === 'ERROR') {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (type === 'OK') pending.resolve(data ? decode(data) : '');
        else pending.reject(new Error(data ? decode(data) : 'OBS command failed.'));
      } else if (this.links.has(id)) {
        if (type === 'ENCODER') {
          const encoder =
            data === 'obs_nvenc_h264_tex'
              ? 'nvenc'
              : data === 'h264_texture_amf'
                ? 'amf'
                : data === 'obs_x264'
                  ? 'x264'
                  : null;
          if (encoder) this.event({ tag: this.tag, linkId: id, encoder });
        }
        if (type === 'ICE' && (data === '0' || (this.sound && data === '1')) && extra)
          this.event({ tag: this.tag, linkId: id, index: Number(data), ice: decode(extra) });
        if (
          type === 'STATE' &&
          (data === 'connecting' ||
            data === 'connected' ||
            data === 'disconnected' ||
            data === 'failed')
        )
          this.event({ tag: this.tag, linkId: id, state: data });
      }
    }
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.stop(new Error(reason));
    this.ended(reason);
  }

  private request(...fields: string[]): Promise<string> {
    if (this.closed) return Promise.reject(sourceEnded());
    // Closing a tracked peer has its own bounded admission and must work even when controls are busy.
    if (fields[0] !== 'close' && this.pending.size >= 24)
      return Promise.reject(new Error('OBS controls are busy.'));
    const id = String(++this.sequence);
    const command = [id, ...fields].join('\t') + '\n';
    if (command.length > maxLine) return Promise.reject(new Error('OBS command is too large.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('The native screen helper timed out.'), 6500);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(command);
    });
  }

  start(target: string[]) {
    this.sound = target.includes('app') || target.includes('system');
    return this.request('start', ...target);
  }

  private lease(id: string, deadline: number) {
    const remaining = deadline - Date.now();
    if (!Number.isSafeInteger(deadline) || remaining <= 0 || remaining > 45000)
      throw new Error('Native viewer authorization expired.');
    clearTimeout(this.links.get(id));
    this.links.set(
      id,
      setTimeout(() => {
        void this.closeLink(id).catch(() =>
          this.fail('Could not retire the expired native viewer.'),
        );
      }, remaining),
    );
  }

  private async closeLink(id: string) {
    this.generations.delete(id);
    this.offers.delete(id);
    if (!this.links.has(id)) return '';
    clearTimeout(this.links.get(id));
    this.links.delete(id);
    const tunnel = this.turnTls.get(id);
    this.turnTls.delete(id);
    this.closing.add(id);
    try {
      return await this.request('close', id);
    } finally {
      this.closing.delete(id);
      tunnel?.close();
    }
  }

  async command(command: NativeScreenCommand) {
    const { linkId, op } = command;
    if (this.closed || command.tag !== this.tag || !nativeLinkId(linkId)) throw sourceEnded();
    if (op === 'close')
      return this.closeLink(linkId).catch((error: unknown) => {
        if (this.closed) return '';
        this.fail('Could not stop the native viewer.');
        throw error;
      });
    const existing = this.links.has(linkId);
    if (op === 'open' || op === 'restart') {
      const current = this.generations.get(linkId);
      if (this.closing.has(linkId) || (op === 'open' ? current : !existing || current?.opening))
        throw new Error('The native viewer state changed.');
      if (op === 'open' && this.generations.size + this.closing.size >= this.viewerBatchSize)
        throw new Error('The native viewer authorization batch is full.');
      const generation = { opening: true };
      this.generations.set(linkId, generation);
      let tunnel: Awaited<ReturnType<typeof openTurnTls>> | undefined;
      const previousTunnel = this.turnTls.get(linkId);
      try {
        await this.grants.deadline(linkId);
        if (this.generations.get(linkId) !== generation) throw sourceEnded();
        const { uris, secure } = this.ice;
        const endpoints = [...uris];
        if (secure) {
          tunnel = await openTurnTls(secure.host, secure.port);
          if (this.generations.get(linkId) !== generation) throw sourceEnded();
          endpoints.push(`turn://${secure.credentials}@127.0.0.1:${tunnel.port}?transport=tcp`);
        }
        const args = [...video(command.video), ...endpoints.map(encode)];
        this.lease(linkId, Math.min(this.grants.currentDeadline(linkId), command.deadline));
        const sdp = await this.request(op, linkId, ...args);
        if (this.generations.get(linkId) !== generation) throw sourceEnded();
        if (tunnel) this.turnTls.set(linkId, tunnel);
        else this.turnTls.delete(linkId);
        previousTunnel?.close();
        this.offers.set(linkId, sdp);
        generation.opening = false;
        return sdp;
      } catch (error) {
        tunnel?.close();
        if (this.generations.get(linkId) === generation)
          await this.closeLink(linkId).catch(() =>
            this.fail('Could not retire the native viewer.'),
          );
        throw error;
      }
    }
    if (!existing) throw new Error('The native viewer ended.');
    if (op === 'lease') {
      const generation = this.generations.get(linkId);
      const deadline = await this.grants.deadline(linkId);
      if (this.generations.get(linkId) !== generation) throw sourceEnded();
      this.lease(linkId, Math.min(deadline, command.deadline));
      return '';
    }
    if (op === 'quality') return this.request(op, linkId, ...video(command.video));
    const generation = this.generations.get(linkId);
    const { parseScreenDescription, parseScreenIce } = await import('@tricord/shared');
    if (this.closed || this.generations.get(linkId) !== generation || !this.links.has(linkId))
      throw sourceEnded();
    if (op === 'local' || op === 'answer') {
      const description = parseScreenDescription(command.sdp, op === 'local' ? 'offer' : 'answer');
      if (op === 'local' && command.sdp !== this.offers.get(linkId))
        throw new Error('Native offer changed.');
      if (op === 'answer') {
        const hash = createHash('sha256').update(command.sdp).digest('hex');
        await this.grants.deadline(linkId, hash);
        if (this.generations.get(linkId) !== generation) throw sourceEnded();
        if (!this.grants.currentDeadline(linkId, hash))
          throw new Error('The server did not authorize this native viewer answer.');
      }
      if (description.kinds.join() !== (this.sound ? 'm=video,m=audio' : 'm=video'))
        throw new Error('Invalid native media description.');
      return this.request(op, linkId, encode(command.sdp));
    }
    if (op === 'ice') {
      const ice = parseScreenIce(command.candidate);
      return this.request(op, linkId, String(ice.sdpMLineIndex), encode(ice.candidate));
    }
    throw new Error('Invalid OBS command.');
  }

  stop(error = sourceEnded()) {
    if (this.closed) return;
    this.closed = true;
    this.grants.stop();
    this.generations.clear();
    this.offers.clear();
    for (const timer of this.links.values()) clearTimeout(timer);
    this.links.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const tunnels = [...this.turnTls.values()];
    this.turnTls.clear();
    this.child.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // Pipe closure gives the helper time to release ICE and GPU resources.
      const deadline = setTimeout(() => this.child.kill(), 1500);
      deadline.unref();
      this.child.once('close', () => {
        clearTimeout(deadline);
        for (const tunnel of tunnels) tunnel.close();
      });
    } else for (const tunnel of tunnels) tunnel.close();
  }
}
