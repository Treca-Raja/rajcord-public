import { useLayoutEffect as useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './participant-volume.css';

export function ParticipantVolume({
  participant,
  anchor,
  close,
  volume,
}: {
  participant: { name: string; volume: number };
  anchor: HTMLElement;
  close: () => void;
  volume: (value: number) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [position, setPosition] = useState({ left: 16, top: 16 });
  useEffect(() => {
    const close = () => closeRef.current();
    const previous = document.activeElement as HTMLElement | null;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(rect.right, window.innerWidth - (panel.current?.offsetWidth ?? 248) - 8),
      ),
      top: Math.max(
        8,
        Math.min(rect.top, window.innerHeight - (panel.current?.offsetHeight ?? 180) - 8),
      ),
    });
    panel.current?.querySelector('input')?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node))
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        const items = panel.current?.querySelectorAll<HTMLElement>('input, button');
        if (!items?.length) return;
        const next = event.shiftKey ? items[0] : items[items.length - 1];
        if (document.activeElement === next) {
          event.preventDefault();
          (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
        }
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
      previous?.focus();
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={panel}
      className="voice-participant-popup"
      role="dialog"
      aria-label={participant.name + ' voice controls'}
      style={position}
    >
      <div className="voice-popup-heading">
        <strong>{participant.name}</strong>
        <button aria-label="Close user volume" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <label>
        User Volume <output>{Math.round(participant.volume * 100)}%</output>
        <input
          aria-label={'Volume for ' + participant.name}
          type="range"
          min="0"
          max="1"
          step=".05"
          value={participant.volume}
          onChange={(event) => volume(Number(event.target.value))}
        />
      </label>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
