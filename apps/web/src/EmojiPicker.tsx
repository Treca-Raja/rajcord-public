import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Smile,
  Hand,
  Leaf,
  Utensils,
  Car,
  Trophy,
  Lightbulb,
  Hash,
  Flag,
  Star,
} from 'lucide-react';
import { chatEmoji } from '@tricord/shared';
import type { EmojiEntry } from '@tricord/shared/emoji-catalog';
import { categorizedEmoji, emojiColumns, emojiRowHeight, emojiWindow } from './emoji-search';
import { EmojiGlyph } from './EmojiText';
import { useAnimatedPresence } from './useAnimatedPresence';
import './media.css';

const names = [
  'Grinning face',
  'Grinning face with big eyes',
  'Grinning face with smiling eyes',
  'Beaming face',
  'Face with tears of joy',
  'Rolling on the floor laughing',
  'Smiling face',
  'Heart eyes',
  'Partying face',
  'Smiling face with sunglasses',
  'Thinking face',
  'Grinning face with sweat',
  'Crying face',
  'Loudly crying face',
  'Surprised face',
  'Sleeping face',
  'Thumbs up',
  'Thumbs down',
  'Red heart',
  'Blue heart',
  'Green heart',
  'Fire',
  'Party popper',
  'Video game',
  'Waving hand',
  'Clapping hands',
  'Folded hands',
  'Flexed biceps',
  'Check mark',
  'Cross mark',
  'Eyes',
  'Rocket',
];
const popular: EmojiEntry[] = chatEmoji.map((emoji, index) => ({
  emoji,
  name: names[index]!,
  group: -1,
  keywords: names[index]!.toLowerCase(),
}));
const categories = [
  { id: 'popular', label: 'Popular', Icon: Star },
  { id: '0', label: 'Smileys & emotion', Icon: Smile },
  { id: '1', label: 'People & body', Icon: Hand },
  { id: '2', label: 'Animals & nature', Icon: Leaf },
  { id: '3', label: 'Food & drink', Icon: Utensils },
  { id: '4', label: 'Travel & places', Icon: Car },
  { id: '5', label: 'Activities', Icon: Trophy },
  { id: '6', label: 'Objects', Icon: Lightbulb },
  { id: '7', label: 'Symbols', Icon: Hash },
  { id: '8', label: 'Flags', Icon: Flag },
];
let catalogRequest: Promise<typeof import('@tricord/shared/emoji-catalog')> | undefined;

export function EmojiPicker({
  onSelect,
  disabled = false,
  compact = false,
  inline = false,
  onClose,
}: {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
  compact?: boolean;
  inline?: boolean;
  onClose?: () => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const choices = useRef(new Map<number, HTMLButtonElement>());
  const [open, setOpen] = useState(inline),
    [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<EmojiEntry[]>([]),
    [query, setQuery] = useState('');
  const [group, setGroup] = useState('popular'),
    [tone, setTone] = useState(0);
  const [scrollTop, setScrollTop] = useState(0),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  const present = useAnimatedPresence(open && !disabled);
  const filtered = useMemo(
    () =>
      !query.trim() && group === 'popular'
        ? popular
        : categorizedEmoji(catalog, query, group === 'popular' ? 'all' : group, tone),
    [catalog, query, group, tone],
  );
  const windowed = emojiWindow(filtered.length, scrollTop);
  const shown = filtered.slice(windowed.start, windowed.end);
  useEffect(() => {
    if (!open || disabled) return;
    let active = true;
    catalogRequest ??= import('@tricord/shared/emoji-catalog');
    void catalogRequest
      .then((module) => {
        if (active) {
          setCatalog(module.emojiCatalog);
          setError('');
        }
      })
      .catch(() => {
        catalogRequest = undefined;
        if (active) setError('The full emoji catalog could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [open, disabled, reload]);
  function close(restore = true) {
    setOpen(false);
    if (inline) onClose?.();
    else if (restore) toggle.current?.focus();
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open || disabled) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, disabled]);
  function reset() {
    setScrollTop(0);
    setActive(0);
    if (scroll.current) scroll.current.scrollTop = 0;
  }
  function focusIndex(index: number) {
    if (!filtered.length) return;
    const next = Math.max(0, Math.min(filtered.length - 1, index));
    setActive(next);
    const row = Math.floor(next / emojiColumns),
      area = scroll.current;
    if (area) {
      if (row * emojiRowHeight < area.scrollTop) area.scrollTop = row * emojiRowHeight;
      else if ((row + 1) * emojiRowHeight > area.scrollTop + area.clientHeight)
        area.scrollTop = (row + 1) * emojiRowHeight - area.clientHeight;
      setScrollTop(area.scrollTop);
    }
    requestAnimationFrame(() => choices.current.get(next)?.focus());
  }
  function navigate(event: KeyboardEvent, index: number) {
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'ArrowDown'
            ? index + emojiColumns
            : event.key === 'ArrowUp'
              ? index - emojiColumns
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? filtered.length - 1
                  : null;
    if (next !== null) {
      event.preventDefault();
      focusIndex(next);
    }
  }
  return (
    <div
      className={
        'emoji-picker' +
        (compact ? ' emoji-picker-compact' : '') +
        (inline ? ' emoji-picker-inline' : '')
      }
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {!inline && (
        <button
          type="button"
          ref={toggle}
          disabled={disabled}
          aria-expanded={open && !disabled}
          aria-controls={id}
          aria-label={compact ? 'Insert emoji' : 'Emoji'}
          title={compact ? 'Insert emoji' : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          {compact ? (
            <Smile size={21} aria-hidden="true" />
          ) : (
            <>
              <EmojiGlyph emoji="😀" /> Emoji
            </>
          )}
        </button>
      )}
      {present && (
        <div
          className="emoji-picker-panel animated-surface"
          id={id}
          role="group"
          aria-label="Emoji choices"
          data-open={open && !disabled}
          inert={!open || disabled}
        >
          <label className="emoji-search">
            <span className="sr-only">Search all emoji</span>
            <input
              ref={search}
              type="search"
              placeholder="Search emoji"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                reset();
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  focusIndex(0);
                }
              }}
            />
          </label>
          <div className="emoji-category-tabs" role="tablist" aria-label="Emoji categories">
            {categories.map(({ id: key, label, Icon }) => (
              <button
                type="button"
                role="tab"
                key={key}
                title={label}
                aria-label={label}
                aria-selected={group === key}
                tabIndex={group === key ? 0 : -1}
                onClick={() => {
                  setGroup(key);
                  setQuery('');
                  reset();
                }}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    categories[
                      (categories.findIndex((entry) => entry.id === key) +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        categories.length) %
                        categories.length
                    ]!;
                  setGroup(next.id);
                  setQuery('');
                  reset();
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>('[aria-label="' + next.label + '"]')
                    ?.focus();
                }}
              >
                <Icon size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="emoji-section-label">
            <strong>
              {query ? 'Search results' : categories.find((entry) => entry.id === group)?.label}
            </strong>
            <select
              aria-label="Emoji skin tone"
              value={tone}
              onChange={(event) => {
                setTone(Number(event.target.value));
                reset();
              }}
            >
              {[
                'Default tone',
                'Light tone',
                'Medium-light tone',
                'Medium tone',
                'Medium-dark tone',
                'Dark tone',
              ].map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {!catalog.length && (
            <p className="emoji-loading" role="status">
              Loading full catalog…
            </p>
          )}
          {error && (
            <p role="alert">
              {error}{' '}
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                Retry
              </button>
            </p>
          )}
          <div
            className="emoji-scroll"
            ref={scroll}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div className="emoji-scroll-space" style={{ height: windowed.height }}>
              <div
                className="emoji-picker-grid"
                role="group"
                aria-label="Emoji"
                style={{ transform: `translateY(${windowed.offset}px)` }}
              >
                {shown.map((entry, localIndex) => {
                  const index = windowed.start + localIndex;
                  return (
                    <button
                      type="button"
                      key={entry.emoji}
                      title={entry.name}
                      aria-label={entry.name}
                      ref={(element) => {
                        if (element) choices.current.set(index, element);
                        else choices.current.delete(index);
                      }}
                      tabIndex={active === index ? 0 : -1}
                      onFocus={() => setActive(index)}
                      onKeyDown={(event) => navigate(event, index)}
                      onClick={() => {
                        close();
                        onSelect(entry.emoji);
                      }}
                    >
                      <EmojiGlyph emoji={entry.emoji} />
                    </button>
                  );
                })}
              </div>
            </div>
            {!filtered.length && catalog.length > 0 && <p>No matching emoji.</p>}
          </div>
          <footer className="emoji-picker-footer">
            <span>Categories · scroll to browse</span>
            <button type="button" onClick={() => close()}>
              Done
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
