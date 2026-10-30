import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ChatMessage, Conversation, ChannelReference } from '@tricord/shared';
import { SendHorizontal, X, Hash, Volume2, AtSign } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';
import { composerSuggestions, referenceLabel, type ComposerSuggestion } from './channel-references';
import { GifSearch } from './GifSearch';
import { useAnimatedPresence } from './useAnimatedPresence';

export function ChatComposer({
  body,
  onChange,
  onSend,
  reply,
  replyLoading,
  onCancelReply,
  disabled,
  sending,
  retrying,
  members,
  userId,
  channels = [],
  onReference,
  onSendGif,
}: {
  body: string;
  onChange: (body: string) => void;
  onSend: (event: FormEvent) => void;
  reply: ChatMessage | null;
  replyLoading: boolean;
  onCancelReply: () => void;
  disabled: boolean;
  sending: boolean;
  retrying: boolean;
  members: Conversation['members'];
  userId: string;
  channels?: ChannelReference[];
  onReference?: (channel: ChannelReference) => boolean;
  onSendGif?: (url: string) => Promise<void>;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(body.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const gifPresent = useAnimatedPresence(gifOpen);
  useEffect(() => {
    if (!gifOpen) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const panel = controls.current?.querySelector('.gif-search-panel');
      const trigger = controls.current?.querySelector('button[aria-label="Search GIFs"]');
      if (!panel?.contains(event.target) && !trigger?.contains(event.target)) setGifOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [gifOpen]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }, [body]);
  const prefix = body.slice(0, caret);
  const match = prefix.match(/(^|[^\p{L}\p{N}_@])@([^\n@]{0,80})$/u);
  const query = !dismissed && match ? match[2]!.toLowerCase() : null;
  const suggestions =
    focused && query !== null ? composerSuggestions(members, channels, query) : [];
  function insert(
    value: string,
    start = textarea.current?.selectionStart ?? body.length,
    end = textarea.current?.selectionEnd ?? start,
  ) {
    const updated = body.slice(0, start) + value + body.slice(end);
    if (updated.length > 4000) {
      setError('Messages support up to 4000 characters.');
      return false;
    }
    onChange(updated);
    setCaret(start + value.length);
    setDismissed(true);
    setError('');
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + value.length, start + value.length);
    });
    return true;
  }
  const gifCommand = /^\/gif\s*$/i.test(body);
  function openGif() {
    if (gifCommand) onChange('');
    setGifOpen(true);
    setDismissed(true);
  }
  function closeGif() {
    setGifOpen(false);
    textarea.current?.focus({ preventScroll: true });
  }
  function optionId(suggestion: ComposerSuggestion) {
    return (
      'mention-option-' + (suggestion.kind === 'user' ? '' : suggestion.kind + '-') + suggestion.id
    );
  }
  function mention(suggestion: ComposerSuggestion) {
    let end = caret;
    while (end < body.length && /[a-z0-9_]/i.test(body[end]!)) end++;
    if (suggestion.kind !== 'user' && onReference && !onReference(suggestion)) return;
    insert(
      (suggestion.kind === 'user' ? '@' + suggestion.username : referenceLabel(suggestion)) + ' ',
      prefix.lastIndexOf('@'),
      end,
    );
  }
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (gifCommand && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      openGif();
      return;
    }
    if (
      suggestions.length &&
      !event.shiftKey &&
      ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === 'Escape') setDismissed(true);
      else if (event.key === 'Enter' || event.key === 'Tab')
        mention(suggestions[active % suggestions.length]!);
      else
        setActive(
          (previous) =>
            (previous + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) %
            suggestions.length,
        );
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSend(event);
    }
  }
  return (
    <div className="chat-composer-controls" ref={controls}>
      {replyLoading && <p role="status">Checking reply target…</p>}
      {reply && (
        <div className="reply-target" role="status">
          <span>
            Replying to {reply.author.displayName} (@{reply.author.username})
          </span>
          <span className="truncate">{reply.body}</span>
          <button
            type="button"
            title="Cancel reply"
            aria-label="Cancel reply"
            onClick={onCancelReply}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {retrying && !sending && (
        <p role="status">
          Delivery is not yet confirmed. Retrying uses the same message identifier.
        </p>
      )}
      <form
        className="composer live-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (sending || disabled || replyLoading || !body.trim()) return;
          if (gifCommand) {
            openGif();
            return;
          }
          textarea.current?.focus({ preventScroll: true });
          setDismissed(true);
          onSend(event);
        }}
      >
        <textarea
          ref={textarea}
          name="message"
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={suggestions.length ? 'mention-options' : undefined}
          aria-activedescendant={
            suggestions.length ? optionId(suggestions[active % suggestions.length]!) : undefined
          }
          placeholder={
            disabled
              ? 'Sending is unavailable here'
              : reply
                ? 'Write a reply'
                : 'Send a little something · @ to mention'
          }
          value={body}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
            setActive(0);
            setDismissed(false);
            setError('');
          }}
          onFocus={() => {
            setFocused(true);
            setGifOpen(false);
          }}
          onBlur={() => setFocused(false)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={keydown}
          maxLength={4000}
          disabled={disabled}
          rows={1}
        />
        <EmojiPicker
          compact
          disabled={disabled || replyLoading}
          onSelect={(emoji) => insert(emoji)}
        />
        <button
          type="button"
          className="composer-gif"
          aria-label="Search GIFs"
          title="Search GIFs · /gif"
          disabled={disabled || replyLoading}
          aria-expanded={gifOpen}
          onClick={() => (gifOpen ? closeGif() : openGif())}
        >
          GIF
        </button>
        <button
          type="submit"
          className="composer-send"
          aria-label="Send message"
          title={sending ? 'Saving…' : retrying ? 'Retry send' : 'Send message'}
          disabled={disabled || sending || replyLoading || !body.trim()}
        >
          <SendHorizontal size={19} aria-hidden="true" />
        </button>
      </form>
      {gifCommand && !gifOpen && (
        <button type="button" className="gif-command-suggestion" onClick={openGif}>
          <strong>/gif</strong> Search GIFs <small>Enter to open</small>
        </button>
      )}
      {gifPresent && (
        <GifSearch
          open={gifOpen}
          onClose={closeGif}
          onDismiss={() => setGifOpen(false)}
          onSend={async (url) => {
            if (!onSendGif) throw new Error('GIF sending is unavailable in this conversation.');
            await onSendGif(url);
          }}
        />
      )}
      {suggestions.length > 0 && (
        <div
          className="mention-options"
          role="listbox"
          id="mention-options"
          aria-label="Mention a member"
        >
          {suggestions.map((member, index) => (
            <button
              type="button"
              key={member.id}
              role="option"
              id={optionId(member)}
              aria-selected={index === active % suggestions.length}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => mention(member)}
            >
              <span className="mention-kind-icon" aria-hidden="true">
                {member.kind === 'user' ? (
                  <AtSign size={16} />
                ) : member.kind === 'channel' ? (
                  <Hash size={16} />
                ) : (
                  <Volume2 size={16} />
                )}
              </span>
              <span className="mention-name">
                {member.kind === 'user' ? member.displayName : member.name}
                {member.kind === 'user' && member.id === userId ? ' · You' : ''}
              </span>
              <span className="mention-username">
                {member.kind === 'user'
                  ? '@' + member.username
                  : member.kind === 'channel'
                    ? 'Text channel'
                    : 'Voice channel'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
