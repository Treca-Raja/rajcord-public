import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Smile } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';

export interface MessageMenuAction {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

export function MessageMenu({
  point,
  anchor,
  actions,
  canReact,
  onReact,
  onClose,
}: {
  point: { x: number; y: number };
  anchor: RefObject<HTMLElement | null>;
  actions: MessageMenuAction[];
  canReact: boolean;
  onReact: (emoji: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [reaction, setReaction] = useState(false);
  function close(restoreFocus: boolean) {
    onClose();
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(point.x, innerWidth - bounds.width - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(point.y, innerHeight - bounds.height - 8)) + 'px';
    element.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) onClose();
    };
    const dismiss = () => onClose();
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [point.x, point.y, reaction, onClose]);
  return createPortal(
    <div
      ref={menu}
      className="message-context-menu"
      role={reaction ? 'dialog' : 'menu'}
      aria-label={reaction ? 'Add reaction' : 'Message actions'}
      style={{ left: point.x, top: point.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        if (reaction || !['ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(event.key)) return;
        if (event.key === 'Tab') {
          close(true);
          return;
        }
        event.preventDefault();
        const controls = [
          ...(menu.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ) ?? []),
        ];
        const index = controls.findIndex((control) => control === document.activeElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? controls.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}
    >
      {reaction ? (
        <EmojiPicker
          inline
          onClose={() => close(true)}
          onSelect={(emoji) => {
            onClose();
            onReact(emoji);
          }}
        />
      ) : (
        <>
          {actions.map((action) => (
            <button
              type="button"
              role="menuitem"
              className={action.danger ? 'menu-danger' : ''}
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                close(true);
                action.run();
              }}
            >
              {action.label}
            </button>
          ))}
          {canReact && (
            <button type="button" role="menuitem" onClick={() => setReaction(true)}>
              <Smile size={16} aria-hidden="true" /> Add reaction
            </button>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
