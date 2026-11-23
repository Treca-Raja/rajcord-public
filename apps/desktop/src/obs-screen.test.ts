import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { ObsScreen } from './obs-screen.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('keeps nine simultaneous opens, renewals and removals scoped to their native peers', async () => {
  const { NATIVE_VIEWER_GRANT_BATCH_SIZE } = await import('@tricord/shared');
  vi.useFakeTimers();
  const stdout = new PassThrough();
  const commands: string[][] = [];
  const peers = new Set<string>();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, done) {
        const [seq, op, id] = String(chunk).trimEnd().split('\t');
        commands.push([op!, id!]);
        if (op === 'open' || op === 'restart') peers.add(id!);
        if (op === 'close') peers.delete(id!);
        stdout.write(`OK\t${seq}\n`);
        done();
      },
    }),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
  });
  child.stdin.once('close', () => {
    peers.clear();
    child.exitCode = 0;
    child.emit('close', 0, null);
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const ended = vi.fn();
  const sender = new ObsScreen(
    { available: true, root: 'fixture', executable: 'fixture' },
    'share',
    vi.fn(),
    ended,
    NATIVE_VIEWER_GRANT_BATCH_SIZE,
  );
  const viewers = Array.from({ length: 9 }, () => ({
    id: randomUUID(),
    remainingMs: 5000,
    answerHash: null,
  }));
  const observe = (next = viewers) => sender.observe({ viewers: next, iceServers: [] }, Date.now());
  const open = (linkId: string, op: 'open' | 'restart' = 'open') =>
    sender.command({
      tag: 'share',
      linkId,
      op,
      deadline: Date.now() + 5000,
      video: { width: 1920, height: 1080, fps: 60, bitrate: 12000000 },
    });
  try {
    const opening = viewers.map(({ id }) => open(id));
    await expect(open(viewers[0]!.id)).rejects.toThrow('viewer state changed');
    expect(commands).toEqual([]);
    observe();
    await Promise.all(opening);
    expect(peers.size).toBe(9);
    await vi.advanceTimersByTimeAsync(4500);
    observe(viewers.slice(1));
    await vi.advanceTimersByTimeAsync(501);
    expect(peers).toEqual(new Set(viewers.slice(1).map(({ id }) => id)));
    const restarting = open(viewers[1]!.id, 'restart');
    await expect(open(viewers[1]!.id, 'restart')).rejects.toThrow('viewer state changed');
    await restarting;
    expect(peers.size).toBe(8);
    await vi.advanceTimersByTimeAsync(4500);
    expect(peers.size).toBe(0);
    const expired = expect(open(viewers[2]!.id)).rejects.toThrow('did not authorize');
    await vi.advanceTimersByTimeAsync(3500);
    await expired;
    observe();
    await Promise.all(viewers.map(({ id }) => open(id)));
    expect(peers.size).toBe(9);
    expect(ended).not.toHaveBeenCalled();
  } finally {
    sender.stop();
    await sender.stopped;
  }
  expect(peers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.kill).not.toHaveBeenCalled();
});
