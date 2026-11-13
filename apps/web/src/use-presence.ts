import { useEffect, useRef, useState } from 'react';
import { PRESENCE_TIMING } from '@tricord/shared';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  PresenceSnapshot,
  PresenceDelta,
} from '@tricord/shared';
import { applyPresenceDelta } from './presence-state';

export function usePresence(socket: Socket<ServerToClientEvents, ClientToServerEvents> | null) {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const [rosterVersion, setRosterVersion] = useState(0);
  const [retryVersion, retry] = useState(0);
  const retrying = useRef(false);
  useEffect(() => {
    setSnapshot(null);
    if (!socket) return;
    let active = true;
    let current: PresenceSnapshot | null = null;
    let generation = 0;
    let pending = false;
    let buffered: PresenceDelta[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let recoveryEpoch: string | null = null;
    function unavailable(recover = true) {
      current = null;
      setSnapshot(null);
      if (recover && socket?.connected && !timer && attempts < 2) {
        timer = setTimeout(() => {
          timer = undefined;
          synchronize();
        }, 2000);
      }
    }
    function synchronize() {
      if (!active || !socket?.connected || pending) return;
      pending = true;
      attempts++;
      const started = ++generation;
      buffered = [];
      socket
        .timeout(PRESENCE_TIMING.snapshotTimeoutMs)
        .emit('presence:snapshot', (timeout, ack) => {
          if (!active || started !== generation) return;
          pending = false;
          if (timeout || !ack.ok) return unavailable();
          current = ack.data;
          recoveryEpoch = current.epoch;
          for (const delta of buffered) {
            current = current && applyPresenceDelta(current, delta);
          }
          buffered = [];
          if (!current) return unavailable();
          attempts = 0;
          setSnapshot(current);
          setRosterVersion((v) => v + 1);
        });
    }
    function changed(delta: PresenceDelta) {
      if (delta.rosterChanged) setRosterVersion((v) => v + 1);
      if (!current && delta.epoch !== recoveryEpoch) {
        recoveryEpoch = delta.epoch;
        attempts = 0;
      }
      if (pending) {
        if (buffered.length < 128) buffered.push(delta);
        else {
          generation++;
          pending = false;
          unavailable();
        }
        return;
      }
      if (!current) return unavailable();
      current = applyPresenceDelta(current, delta);
      if (!current) unavailable();
      else setSnapshot(current);
    }
    function connect() {
      attempts = 0;
      synchronize();
    }
    function disconnected() {
      generation++;
      pending = false;
      buffered = [];
      clearTimeout(timer);
      timer = undefined;
      unavailable(false);
    }
    function failed() {
      generation++;
      pending = false;
      unavailable();
    }
    socket.on('connect', connect);
    socket.on('disconnect', disconnected);
    socket.on('presence:changed', changed);
    socket.on('presence:unavailable', failed);
    synchronize();
    retrying.current = false;
    return () => {
      active = false;
      clearTimeout(timer);
      socket.off('connect', connect);
      socket.off('disconnect', disconnected);
      socket.off('presence:changed', changed);
      socket.off('presence:unavailable', failed);
    };
  }, [socket, retryVersion]);
  return {
    snapshot,
    rosterVersion,
    retry: () => {
      if (retrying.current) return;
      retrying.current = true;
      retry((v) => v + 1);
    },
  };
}
