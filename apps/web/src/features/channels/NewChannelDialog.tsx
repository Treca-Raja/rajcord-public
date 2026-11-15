import { runInBackground } from '../../shared/background';
import type { FormEvent } from 'react';
import type { ChannelCategory, Conversation } from '@tricord/shared';
import { ChannelFields } from './Channels';

export function NewChannelDialog({
  categories,
  busy,
  create,
  openCategories,
}: {
  categories: ChannelCategory[];
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>, kind: Conversation['kind']) => Promise<void>;
  openCategories: (trigger: HTMLElement) => void;
}) {
  return (
    <form onSubmit={(e) => runInBackground(create(e, 'channel'))}>
      <ChannelFields categories={categories} />
      <button
        type="button"
        className="text-button"
        onClick={(event) => openCategories(event.currentTarget)}
      >
        Create or manage categories
      </button>
      <button className="primary" disabled={busy}>
        Create
      </button>
    </form>
  );
}
