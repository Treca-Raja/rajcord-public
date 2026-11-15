import type { ClientToServerEvents, ServerToClientEvents } from '@tricord/shared';
import type { Socket } from 'socket.io-client';
import type { RefObject } from 'react';
import { nearLatest } from './chat-state';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export interface ReadingPosition {
  loading: boolean;
  loaded: boolean;
  readingAllowed: boolean;
  historyMode: boolean;
  panelOpen: boolean;
  pinned: boolean;
  scroll: HTMLDivElement | null;
}

export function trackMessageReading({
  conversationId,
  latestSeq,
  readSeq,
  lastReadRequest,
  socket,
  request,
  position,
}: {
  conversationId: string;
  latestSeq: string;
  readSeq: RefObject<string>;
  lastReadRequest: RefObject<number>;
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  request: Request;
  position: () => ReadingPosition;
}) {
  let active = true,
    pending = false;
  const mark = () => {
    const current = position();
    if (
      !active ||
      pending ||
      Date.now() - lastReadRequest.current < (socket?.connected ? 5000 : 15000) ||
      current.loading ||
      !current.loaded ||
      !current.readingAllowed ||
      current.historyMode ||
      current.panelOpen ||
      !!document.querySelector('[role="dialog"]') ||
      !current.pinned ||
      !current.scroll ||
      !nearLatest(current.scroll) ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus() ||
      BigInt(latestSeq) <= BigInt(readSeq.current)
    )
      return;
    pending = true;
    lastReadRequest.current = Date.now();
    const result = socket?.connected
      ? new Promise<{ lastReadSeq: string }>((resolve, reject) => {
          socket
            .timeout(10000)
            .emit('conversation:read', { conversationId, seq: latestSeq }, (timeout, ack) => {
              if (timeout) reject(new Error('Read acknowledgement timed out.'));
              else if (!ack.ok) reject(new Error(ack.error));
              else resolve(ack.data);
            });
        })
      : request<{ lastReadSeq: string }>('/conversations/' + conversationId + '/read', 'POST', {
          seq: latestSeq,
        });
    void result
      .then((result) => {
        readSeq.current = result.lastReadSeq;
      })
      .catch(() => {
        /* Retry on focus or the next visible update. */
      })
      .finally(() => {
        pending = false;
      });
  };
  mark();
  window.addEventListener('focus', mark);
  document.addEventListener('visibilitychange', mark);
  const retry = setTimeout(
    mark,
    Math.max(0, (socket?.connected ? 5000 : 15000) - (Date.now() - lastReadRequest.current)),
  );
  const timer = setInterval(mark, 5000);
  return () => {
    active = false;
    clearInterval(timer);
    clearTimeout(retry);
    window.removeEventListener('focus', mark);
    document.removeEventListener('visibilitychange', mark);
  };
}
