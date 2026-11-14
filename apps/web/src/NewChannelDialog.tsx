import type { FormEvent } from 'react';
import type { ChannelCategory } from '@tricord/shared';
import { ChannelFields } from './Channels';

export function NewChannelDialog({
  categories,
  busy,
  create,
  openCategories,
}: {
  categories: ChannelCategory[];
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  openCategories: () => void;
}) {
  return (
    <form onSubmit={(e) => void create(e)}>
      <ChannelFields categories={categories} />
      <button type="button" className="text-button" onClick={openCategories}>
        Create or manage categories
      </button>
      <button className="primary" disabled={busy}>
        Create
      </button>
    </form>
  );
}
