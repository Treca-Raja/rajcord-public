import type { RefObject } from 'react';
import { nearLatest } from './chat-state';

export type PendingJump = { id: string | null } | null;

export function checkTimelinePosition(
  scroll: RefObject<HTMLDivElement | null>,
  pinned: RefObject<boolean>,
  pendingJump: RefObject<PendingJump>,
  setAtBottom: (value: boolean) => void,
) {
  if (pendingJump.current) return;
  const area = scroll.current;
  if (area) {
    pinned.current = nearLatest(area);
    setAtBottom(pinned.current);
  }
}

export function settlePendingJump(
  loading: boolean,
  pendingJump: RefObject<PendingJump>,
  scroll: RefObject<HTMLDivElement | null>,
  pinned: RefObject<boolean>,
  checkPosition: () => void,
) {
  const pending = pendingJump.current;
  if (loading || !pending?.id) return;
  // Settle the navigation on the first committed render; never leave scroll tracking suspended.
  pendingJump.current = null;
  const target = scroll.current?.querySelector<HTMLElement>(
    '[data-message-id="' + pending.id + '"]',
  );
  if (target) {
    pinned.current = false;
    target.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    target.focus({ preventScroll: true });
  }
  // A target already in view emits no scroll event, so recompute the reading position explicitly.
  requestAnimationFrame(checkPosition);
}

export function pinLatestMessages(
  loading: boolean,
  loaded: boolean,
  olderBusy: boolean,
  pinned: boolean,
  bottom: HTMLDivElement | null,
) {
  if (!loading && loaded && !olderBusy && pinned) bottom?.scrollIntoView({ block: 'nearest' });
}
