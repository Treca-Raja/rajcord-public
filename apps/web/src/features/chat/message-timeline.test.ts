import { afterEach, expect, it, vi } from 'vitest';
import {
  checkTimelinePosition,
  settlePendingJump,
  pinLatestMessages,
  type PendingJump,
} from './message-timeline';

afterEach(() => vi.unstubAllGlobals());

function timeline(reducedMotion = false) {
  const target = {
    focus: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ top: 360, height: 40 })),
  };
  const area = {
    scrollHeight: 1000,
    scrollTop: 500,
    clientHeight: 500,
    getBoundingClientRect: vi.fn(() => ({ top: 100 })),
    querySelector: vi.fn().mockReturnValue(target),
  };
  const scroll = { current: area as unknown as HTMLDivElement };
  const pinned = { current: true };
  const pending = { current: { id: 'quoted' } as PendingJump };
  const setAtBottom = vi.fn();
  const check = () => checkTimelinePosition(scroll, pinned, pending, setAtBottom);
  const frame = vi.fn();
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reducedMotion }) });
  return { target, area, scroll, pinned, pending, setAtBottom, check, frame };
}

it('keeps position tracking suspended until a pending jump has loaded its anchor', () => {
  const t = timeline();
  t.check();
  settlePendingJump(true, t.pending, t.scroll, t.pinned, t.check);
  expect(t.pending.current).toEqual({ id: 'quoted' });
  expect(t.setAtBottom).not.toHaveBeenCalled();
  expect(t.target.focus).not.toHaveBeenCalled();
  t.pending.current = { id: null };
  settlePendingJump(false, t.pending, t.scroll, t.pinned, t.check);
  expect(t.pending.current).toEqual({ id: null });
  expect(t.frame).not.toHaveBeenCalled();
});

it.each([false, true])(
  'settles the first committed jump and focuses without another scroll (reduced motion: %s)',
  (reducedMotion) => {
    const t = timeline(reducedMotion);
    settlePendingJump(false, t.pending, t.scroll, t.pinned, t.check);
    expect(t.area.querySelector).toHaveBeenCalledWith('[data-message-id="quoted"]');
    expect(t.pending.current).toBeNull();
    expect(t.pinned.current).toBe(false);
    expect(t.area.scrollTop).toBe(530);
    expect(t.target.focus).toHaveBeenCalledWith({ preventScroll: true });
    // Already-visible targets emit no scroll event; the scheduled check must resume reading.
    t.frame.mock.calls[0]![0]();
    expect(t.pinned.current).toBe(true);
    expect(t.setAtBottom).toHaveBeenCalledWith(true);
    settlePendingJump(false, t.pending, t.scroll, t.pinned, t.check);
    expect(t.target.focus).toHaveBeenCalledTimes(1);
  },
);

it('resumes geometry checks even when the loaded anchor is absent from the timeline', () => {
  const t = timeline();
  t.area.querySelector.mockReturnValue(null);
  t.area.scrollTop = 0;
  settlePendingJump(false, t.pending, t.scroll, t.pinned, t.check);
  expect(t.pending.current).toBeNull();
  expect(t.target.focus).not.toHaveBeenCalled();
  t.frame.mock.calls[0]![0]();
  expect(t.pinned.current).toBe(false);
  expect(t.setAtBottom).toHaveBeenCalledWith(false);
});

it('rechecks media/viewport geometry and leaves a missing scroll area alone', () => {
  const t = timeline();
  t.pending.current = null;
  t.check();
  expect(t.setAtBottom).toHaveBeenLastCalledWith(true);
  t.area.scrollHeight = 1500;
  t.check();
  expect(t.setAtBottom).toHaveBeenLastCalledWith(false);
  checkTimelinePosition({ current: null }, t.pinned, t.pending, t.setAtBottom);
  expect(t.setAtBottom).toHaveBeenCalledTimes(2);
});

it('pins new latest content only after loading and outside older-history fetches', () => {
  const bottom = { scrollIntoView: vi.fn() };
  const node = bottom as unknown as HTMLDivElement;
  pinLatestMessages(false, true, false, true, node);
  expect(bottom.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  bottom.scrollIntoView.mockClear();
  pinLatestMessages(true, true, false, true, node);
  pinLatestMessages(false, false, false, true, node);
  pinLatestMessages(false, true, true, true, node);
  pinLatestMessages(false, true, false, false, node);
  pinLatestMessages(false, true, false, true, null);
  expect(bottom.scrollIntoView).not.toHaveBeenCalled();
});
