import type { ChatMessage, Conversation } from '@tricord/shared';
import { encodeChannelReferences, type DraftChannelReference } from './channel-references';

export function mentionSuggestions(members: Conversation['members'], query: string) {
  const prefix = query.toLowerCase();
  return members
    .filter(
      (member) => member.status === 'approved' && member.username.toLowerCase().startsWith(prefix),
    )
    .slice(0, 10);
}

export interface SendAttempt {
  clientId: string;
  body: string;
  replyToId: string | null;
  wireBody?: string;
}
export interface ChatDraft {
  body: string;
  replyToId: string | null;
  attempt: SendAttempt | null;
  references?: DraftChannelReference[];
}
export const emptyDraft: ChatDraft = { body: '', replyToId: null, attempt: null };
export function nearLatest(area: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return area.clientHeight > 0 && area.scrollHeight - area.scrollTop - area.clientHeight < 48;
}
export function isConversationAccessError(error: unknown) {
  return (
    error instanceof Error &&
    'status' in error &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}
export function isReplyTargetGone(error: unknown) {
  return (
    error instanceof Error && 'status' in error && (error.status === 403 || error.status === 404)
  );
}
export class DraftStore extends Map<string, ChatDraft> {
  readonly mediaAttempts = new Map<string, SendAttempt>();
  private readonly listeners = new Map<string, Set<() => void>>();
  subscribe(id: string, listener: () => void) {
    let listeners = this.listeners.get(id);
    if (!listeners) this.listeners.set(id, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  override set(id: string, draft: ChatDraft) {
    super.set(id, draft);
    for (const listener of this.listeners.get(id) ?? []) listener();
    return this;
  }
  override delete(id: string) {
    const changed = super.delete(id);
    if (changed) for (const listener of this.listeners.get(id) ?? []) listener();
    return changed;
  }
  forget(id: string) {
    this.mediaAttempts.delete(id);
    this.delete(id);
  }
  override clear() {
    this.mediaAttempts.clear();
    super.clear();
  }
}
export function attemptFor(
  draft: ChatDraft,
  newId: () => string = () => crypto.randomUUID(),
): SendAttempt {
  const wireBody = encodeChannelReferences(draft.body, draft.references);
  if (
    draft.attempt?.body === draft.body &&
    draft.attempt.replyToId === draft.replyToId &&
    (draft.attempt.wireBody ?? draft.attempt.body) === wireBody
  )
    return draft.attempt;
  return {
    clientId: newId(),
    body: draft.body,
    replyToId: draft.replyToId,
    ...(wireBody === draft.body ? {} : { wireBody }),
  };
}
export function sendPayload(attempt: SendAttempt) {
  return {
    clientId: attempt.clientId,
    body: attempt.wireBody ?? attempt.body,
    ...(attempt.replyToId ? { replyToId: attempt.replyToId } : {}),
  };
}
export function authorAccent(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ['#9ec9ff', '#d2b1ff', '#9cdbbc', '#efc29c', '#f4afd3', '#d6d68d'][hash % 6]!;
}
export function sameMessageGroup(previous: ChatMessage | undefined, current: ChatMessage) {
  return (
    !!previous &&
    previous.author.id === current.author.id &&
    new Date(previous.createdAt).toDateString() === new Date(current.createdAt).toDateString() &&
    new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60000
  );
}
