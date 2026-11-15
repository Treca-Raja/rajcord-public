import { useState, type FormEvent } from 'react';
import { chatMetadataLimits, type ChannelCategory, type Conversation } from '@tricord/shared';
import { useAuth } from './Auth';
import { channelFields } from './channel-state';

export function ChannelFields({
  categories,
  conversation,
}: {
  categories: ChannelCategory[];
  conversation?: Conversation;
}) {
  return (
    <>
      <label>
        Channel name
        <input
          autoFocus
          name="name"
          defaultValue={conversation?.name ?? ''}
          maxLength={chatMetadataLimits.channelName * 2}
          required
          placeholder="Game night"
          aria-describedby="channel-name-help"
        />
        <small id="channel-name-help">1–80 Unicode characters; spaces and emoji are welcome.</small>
      </label>
      <label>
        Topic (optional)
        <textarea
          name="topic"
          defaultValue={conversation?.topic ?? ''}
          maxLength={chatMetadataLimits.topic * 2}
          rows={3}
          aria-describedby="channel-topic-help"
        />
        <small id="channel-topic-help">
          Up to 500 characters. Visible to all approved members.
        </small>
      </label>
      <label>
        Category
        <select name="categoryId" defaultValue={conversation?.category?.id ?? ''}>
          <option value="">Uncategorized</option>
          {conversation?.category &&
            !categories.some((c) => c.id === conversation.category?.id) && (
              <option value={conversation.category.id}>
                {conversation.category.name} (reload to verify)
              </option>
            )}
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Channel order (lower first)
        <input
          name="position"
          type="number"
          min={0}
          max={chatMetadataLimits.position}
          step={1}
          required
          defaultValue={conversation?.position ?? 0}
        />
      </label>
    </>
  );
}

export function ChannelSettings({
  conversation,
  categories,
  onChanged,
}: {
  conversation: Conversation;
  categories: ChannelCategory[];
  onChanged: () => Promise<void>;
}) {
  const { request } = useAuth();
  const [snapshot, setSnapshot] = useState(conversation);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const stale = snapshot.metadataRevision !== conversation.metadataRevision;
  async function save(fields: ReturnType<typeof channelFields> | { archived: boolean }) {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const { conversation: updated } = await request<{ conversation: Conversation }>(
        '/conversations/' + snapshot.id,
        'PATCH',
        { ...fields, expectedRevision: snapshot.metadataRevision },
      );
      setSnapshot(updated);
      setSaved(true);
      await onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="channel-settings">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="form-success" role="status">
          Channel details saved.
        </p>
      )}
      {stale && <p role="status">These details changed in another window. Reload before saving.</p>}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setSnapshot(conversation);
          setReset((previous) => previous + 1);
          setError('');
          setSaved(false);
        }}
      >
        Reload channel details
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(channelFields(new FormData(event.currentTarget)));
        }}
      >
        <fieldset
          disabled={busy || snapshot.archived}
          key={snapshot.metadataRevision + ':' + reset}
        >
          <ChannelFields categories={categories} conversation={snapshot} />
          <button className="primary" disabled={stale}>
            Save channel details
          </button>
        </fieldset>
      </form>
      <p>
        Archiving stops new messages and detail changes. Everyone retains history; authors can still
        edit or delete their own messages. Restore the channel to change its details.
      </p>
      <button
        className="secondary"
        disabled={busy || stale}
        onClick={() => void save({ archived: !snapshot.archived })}
      >
        {snapshot.archived ? 'Restore channel' : 'Archive channel'}
      </button>
    </div>
  );
}

function CategorySettings({
  category,
  onChanged,
}: {
  category: ChannelCategory;
  onChanged: () => Promise<void>;
}) {
  const { request } = useAuth();
  const [snapshot, setSnapshot] = useState(category);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const stale = snapshot.revision !== category.revision;
  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const fields = event ? new FormData(event.currentTarget) : null;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      if (fields) {
        const { category: updated } = await request<{ category: ChannelCategory }>(
          '/channel-categories/' + snapshot.id,
          'PATCH',
          {
            expectedRevision: snapshot.revision,
            name: fields.get('name'),
            position: Number(fields.get('position')),
          },
        );
        setSnapshot(updated);
      } else {
        await request<{ removed: true }>('/channel-categories/' + snapshot.id, 'DELETE', {
          expectedRevision: snapshot.revision,
        });
      }
      setSaved(true);
      setConfirm(false);
      await onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="category-settings"
      data-category-id={category.id}
      aria-label={'Category ' + category.name}
    >
      <h3>{category.name}</h3>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="form-success" role="status">
          Category saved.
        </p>
      )}
      {stale && <p role="status">This category changed. Reload before saving.</p>}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setSnapshot(category);
          setReset((previous) => previous + 1);
          setError('');
          setConfirm(false);
          setSaved(false);
        }}
      >
        Reload category details
      </button>
      <form onSubmit={(event) => void save(event)}>
        <fieldset key={snapshot.revision + ':' + reset} disabled={busy}>
          <label>
            Category name
            <input
              name="name"
              defaultValue={snapshot.name}
              required
              maxLength={chatMetadataLimits.categoryName * 2}
            />
          </label>
          <label>
            Category order (lower first)
            <input
              name="position"
              type="number"
              min={0}
              max={chatMetadataLimits.position}
              step={1}
              required
              defaultValue={snapshot.position}
            />
          </label>
          <button className="primary" disabled={stale}>
            Save category
          </button>
        </fieldset>
      </form>
      {confirm ? (
        <div>
          <p>
            Move every channel in this category to Uncategorized? Messages and history are kept.
          </p>
          <button className="danger" disabled={busy || stale} onClick={() => void save()}>
            Confirm remove category
          </button>
          <button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>
            Cancel removal
          </button>
        </div>
      ) : (
        <button className="danger" disabled={busy || stale} onClick={() => setConfirm(true)}>
          Remove category
        </button>
      )}
    </section>
  );
}

export function CategoryManager({
  categories,
  onChanged,
}: {
  categories: ChannelCategory[];
  onChanged: () => Promise<void>;
}) {
  const { request } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      await request('/channel-categories', 'POST', {
        name: data.get('name'),
        position: Number(data.get('position')),
      });
      form.reset();
      await onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>
        All approved members can manage public categories. Names support 1–48 Unicode characters.
        Order is shared; lower numbers appear first.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={(event) => void create(event)} aria-label="Create category">
        <fieldset disabled={busy}>
          <label>
            New category name
            <input autoFocus name="name" required maxLength={chatMetadataLimits.categoryName * 2} />
          </label>
          <label>
            New category order (lower first)
            <input
              name="position"
              type="number"
              min={0}
              max={chatMetadataLimits.position}
              step={1}
              required
              defaultValue={0}
            />
          </label>
          <button className="primary">Create category</button>
        </fieldset>
      </form>
      {categories.map((category) => (
        <CategorySettings key={category.id} category={category} onChanged={onChanged} />
      ))}
    </>
  );
}
