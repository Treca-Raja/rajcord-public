import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import { MicrophonePermission, installMicrophonePermissions } from './microphone-permission';

const target = 'https://rajcord.example';
const profiles: string[] = [];
function profile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rajcord-mic-unit-'));
  profiles.push(directory);
  return directory;
}
function setup(directory = profile(), origin = target) {
  const ask = vi.fn().mockResolvedValue(true);
  const onError = vi.fn();
  const options = { profileDirectory: directory, target: origin, ask, onError };
  return {
    options,
    ask,
    onError,
    permission: new MicrophonePermission(options),
    file: path.join(directory, 'microphone-permission.json'),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of profiles.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (
      path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('rajcord-mic-unit-')
    )
      throw new Error('Unexpected test profile cleanup target.');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('starts denied without prompting or writing on startup', () => {
  const { permission, ask, file, onError } = setup();
  expect(permission.allowed).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  expect(fs.existsSync(file)).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});
it('remembers explicit approval across instances without another prompt', async () => {
  const { permission, options, ask, file } = setup();
  expect(await permission.request()).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    origin: target,
    microphone: true,
  });
  const restarted = new MicrophonePermission(options);
  expect(restarted.allowed).toBe(true);
  expect(await restarted.request()).toBe(true);
  expect(ask).toHaveBeenCalledOnce();
});
it('does not share approval with another server or app profile', async () => {
  const { permission, options } = setup();
  await permission.request();
  const anotherOrigin = setup(options.profileDirectory, 'https://different.example');
  expect(anotherOrigin.permission.allowed).toBe(false);
  anotherOrigin.ask.mockResolvedValue(false);
  expect(await anotherOrigin.permission.request()).toBe(false);
  expect(new MicrophonePermission(options).allowed).toBe(true);
  expect(setup().permission.allowed).toBe(false);
});
it('Cancel leaves approval unset and permits an explicit retry', async () => {
  const { permission, ask, file } = setup();
  ask.mockResolvedValueOnce(false);
  expect(await permission.request()).toBe(false);
  expect(permission.allowed).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(await permission.request()).toBe(true);
  expect(ask).toHaveBeenCalledTimes(2);
});
it('coalesces concurrent requests into one consent prompt', async () => {
  const { permission, ask } = setup();
  let resolve!: (allowed: boolean) => void;
  ask.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const first = permission.request();
  expect(permission.request()).toBe(first);
  resolve(true);
  expect(await first).toBe(true);
  expect(ask).toHaveBeenCalledOnce();
});
it('reset forgets approval in memory and on restart', async () => {
  const { permission, options, file } = setup();
  await permission.request();
  expect(permission.reset()).toBe(true);
  expect(permission.allowed).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(new MicrophonePermission(options).allowed).toBe(false);
  expect(permission.reset()).toBe(true);
});
it('reset during a pending prompt prevents late approval from being saved', async () => {
  const { permission, ask, file } = setup();
  let resolve!: (allowed: boolean) => void;
  ask.mockReturnValueOnce(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const pending = permission.request();
  permission.reset();
  resolve(true);
  expect(await pending).toBe(false);
  expect(permission.allowed).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(await permission.request()).toBe(true);
});
it.each([
  'invalid json',
  '{}',
  '{"version":2,"origin":"https://rajcord.example","microphone":true}',
  '{"version":1,"origin":"https://rajcord.example","microphone":"true"}',
])('reports invalid saved data and never grants access: %s', (saved) => {
  const directory = profile();
  fs.writeFileSync(path.join(directory, 'microphone-permission.json'), saved);
  const { permission, onError } = setup(directory);
  expect(permission.allowed).toBe(false);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
});
it('reports unreadable storage without granting access', () => {
  vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('Denied'), { code: 'EACCES' });
  });
  const { permission, onError } = setup();
  expect(permission.allowed).toBe(false);
  expect(onError).toHaveBeenCalledOnce();
});
it.each(['writeFileSync', 'renameSync'] as const)(
  'a failed %s reports the problem and does not grant access',
  async (operation) => {
    const { permission, onError } = setup();
    vi.spyOn(fs, operation).mockImplementationOnce(() => {
      throw new Error('Storage unavailable');
    });
    expect(await permission.request()).toBe(false);
    expect(permission.allowed).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  },
);
it('a failed reset still blocks this run and reports that saved approval remains', async () => {
  const { permission, onError } = setup();
  await permission.request();
  vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
    throw new Error('Storage unavailable');
  });
  expect(permission.reset()).toBe(false);
  expect(permission.allowed).toBe(false);
  expect(onError).toHaveBeenCalledWith(
    expect.stringContaining('saved approval could not be removed'),
  );
});
it('a failed prompt is denied, reported and retryable', async () => {
  const { permission, ask, onError } = setup();
  ask.mockRejectedValueOnce(new Error('Dialog unavailable'));
  expect(await permission.request()).toBe(false);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('could not be requested'));
  expect(await permission.request()).toBe(true);
});

function handlers() {
  let request!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let check!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  const session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'> = {
    setPermissionRequestHandler: (handler) => {
      request = handler!;
    },
    setPermissionCheckHandler: (handler) => {
      check = handler!;
    },
  };
  const contents = {
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue(target),
  };
  const webContents = contents as unknown as WebContents;
  const permission = { allowed: true, request: vi.fn().mockResolvedValue(true) };
  installMicrophonePermissions(session, webContents, target, permission);
  const details = { requestingUrl: target, isMainFrame: true, mediaTypes: ['audio'] } as Parameters<
    typeof request
  >[3];
  return { request, check, permission, contents, webContents, details };
}
it('saved consent never permits another window, foreign origin, subframe, camera or display', () => {
  const { request, check, permission, webContents, details } = handlers();
  const rejected = [
    { ...details, requestingUrl: 'https://evil.example' },
    { ...details, isMainFrame: false },
    { ...details, mediaTypes: ['video'] },
    { ...details, mediaTypes: ['audio', 'video'] },
  ];
  for (const input of rejected) {
    const callback = vi.fn();
    request(webContents, 'media', callback, input);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  }
  const callback = vi.fn();
  request({} as WebContents, 'media', callback, details);
  expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  expect(permission.request).not.toHaveBeenCalled();
  for (const [kind, mediaType] of [
    ['media', 'video'],
    ['display-capture', 'audio'],
  ] as const)
    expect(
      check(webContents, kind, target, { isMainFrame: true, mediaType } as Parameters<
        typeof check
      >[3]),
    ).toBe(false);
  expect(
    check({} as WebContents, 'speaker-selection', target, { isMainFrame: true } as Parameters<
      typeof check
    >[3]),
  ).toBe(false);
});
it.each(['navigation', 'destroyed'] as const)(
  'a pending request cannot grant access after %s',
  async (change) => {
    const { request, permission, contents, webContents, details } = handlers();
    let resolve!: (allowed: boolean) => void;
    permission.request.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const callback = vi.fn();
    request(webContents, 'media', callback, details);
    if (change === 'navigation') contents.getURL.mockReturnValue('https://evil.example');
    else contents.isDestroyed.mockReturnValue(true);
    resolve(true);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
  },
);
it('revocation before the permission callback cannot grant a stale approval', async () => {
  const { request, permission, webContents, details } = handlers();
  let resolve!: (allowed: boolean) => void;
  permission.request.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const callback = vi.fn();
  request(webContents, 'media', callback, details);
  permission.allowed = false;
  resolve(true);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
});
