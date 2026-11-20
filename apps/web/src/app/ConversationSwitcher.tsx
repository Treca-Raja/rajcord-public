import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Hash, MessageCircle, Users, X } from 'lucide-react';
import type { Conversation } from '@tricord/shared';

export function ConversationSwitcher({
  conversations,
  priorityIds,
  userId,
  onChoose,
  onClose,
}: {
  conversations: Conversation[];
  priorityIds: string[];
  userId: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const search = query.trim().replace(/^[@#]/, '').toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!search) {
      const ordered = priorityIds.flatMap(
        (id) => conversations.find((item) => item.id === id) ?? [],
      );
      return [...ordered, ...conversations.filter((item) => !priorityIds.includes(item.id))];
    }
    return conversations.filter(
      (conversation) =>
        conversation.name.toLocaleLowerCase().includes(search) ||
        (conversation.kind === 'dm' &&
          conversation.members.some(
            (member) =>
              member.id !== userId && member.username.toLocaleLowerCase().includes(search),
          )),
    );
  }, [conversations, priorityIds, search, userId]);
  const active = matches[Math.min(activeIndex, matches.length - 1)];
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const activeId = active?.id;
  useLayoutEffect(() => {
    if (activeId) document.getElementById('jump-' + activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  return (
    <dialog
      ref={dialog}
      className="conversation-switcher"
      aria-label="Switch conversation"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="jump-content">
        <div className="jump-input">
          <Search size={18} aria-hidden="true" />
          <input
            type="text"
            autoFocus
            autoComplete="off"
            placeholder="Find a channel or conversation"
            aria-label="Find a channel or conversation"
            role="combobox"
            aria-expanded="true"
            aria-controls="jump-results"
            aria-autocomplete="list"
            aria-activedescendant={active && 'jump-' + active.id}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || !active) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                onChoose(active.id);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActiveIndex(
                  (Math.min(activeIndex, matches.length - 1) + step + matches.length) %
                    matches.length,
                );
              }
            }}
          />
          <button aria-label="Close switcher" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div id="jump-results" role="listbox" aria-label="Conversations">
          {matches.map((conversation) => {
            const Icon =
              conversation.kind === 'channel'
                ? Hash
                : conversation.kind === 'group'
                  ? Users
                  : MessageCircle;
            return (
              <button
                role="option"
                tabIndex={-1}
                id={'jump-' + conversation.id}
                key={conversation.id}
                aria-selected={active?.id === conversation.id}
                onClick={() => onChoose(conversation.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="truncate">{conversation.name}</span>
                <small>
                  {conversation.archived
                    ? 'Archived'
                    : conversation.kind === 'channel'
                      ? 'Channel'
                      : conversation.kind === 'group'
                        ? 'Group'
                        : 'DM'}
                </small>
              </button>
            );
          })}
        </div>
        {!matches.length && <p role="status">No matching conversations</p>}
      </div>
    </dialog>
  );
}
