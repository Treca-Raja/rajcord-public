import type { FormEvent } from 'react';
import type { AuthUser, ChannelCategory, Conversation } from '@tricord/shared';
import { X } from 'lucide-react';
import { CategoryManager, ChannelSettings } from './Channels';
import { useAuth } from './Auth';
import { NewChannelDialog } from './NewChannelDialog';
import { NewDirectMessageDialog } from './NewDirectMessageDialog';
import { NewGroupDialog } from './NewGroupDialog';

export type ConversationDialogMode = 'channel' | 'dm' | 'group' | 'manage' | 'categories';

export function ConversationDialog({
  modal,
  current,
  categories,
  members,
  error,
  busy,
  reload,
  create,
  openDialog,
  setModal,
  action,
  nextCategoryPage,
  categoriesBusy,
  moreCategories,
}: {
  modal: ConversationDialogMode;
  current: Conversation | undefined;
  categories: ChannelCategory[];
  members: AuthUser[];
  error: string;
  busy: boolean;
  reload: () => Promise<void>;
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  openDialog: (mode: ConversationDialogMode) => void;
  setModal: (mode: ConversationDialogMode | null) => void;
  action: (work: () => Promise<unknown>) => Promise<void>;
  nextCategoryPage: string | null;
  categoriesBusy: boolean;
  moreCategories: () => Promise<void>;
}) {
  const { state, request } = useAuth();
  return (
    <div className="modal-backdrop">
      <section
        className="account-panel chat-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={
          modal === 'manage'
            ? 'Manage conversation'
            : modal === 'categories'
              ? 'Manage categories'
              : 'New conversation'
        }
      >
        <header>
          <h2>
            {modal === 'categories'
              ? 'Manage categories'
              : modal === 'channel'
                ? 'Create a channel'
                : modal === 'dm'
                  ? 'Start a direct message'
                  : modal === 'group'
                    ? 'Create a group'
                    : current?.name}
          </h2>
          <button aria-label="Close dialog" onClick={() => setModal(null)}>
            <X />
          </button>
        </header>
        <div className="account-content">
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {modal === 'categories' ? (
            <CategoryManager categories={categories} onChanged={reload} />
          ) : modal === 'channel' ? (
            <NewChannelDialog
              categories={categories}
              busy={busy}
              create={create}
              openCategories={() => openDialog('categories')}
            />
          ) : modal === 'dm' ? (
            <NewDirectMessageDialog
              members={members}
              userId={state.user.id}
              busy={busy}
              create={create}
            />
          ) : modal === 'group' ? (
            <NewGroupDialog members={members} userId={state.user.id} busy={busy} create={create} />
          ) : (
            current && (
              <>
                {current.kind === 'channel' && (
                  <ChannelSettings
                    key={current.id}
                    conversation={current}
                    categories={categories}
                    onChanged={reload}
                  />
                )}
                {current.kind === 'channel' && (
                  <button className="text-button" onClick={() => openDialog('categories')}>
                    Create or manage categories
                  </button>
                )}
                {current.kind === 'group' && current.managerId === state.user.id && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = new FormData(e.currentTarget).get('name');
                      void action(() => request('/conversations/' + current.id, 'PATCH', { name }));
                    }}
                  >
                    <label>
                      Name
                      <input name="name" defaultValue={current.name} required maxLength={80} />
                    </label>
                    <button className="secondary" disabled={busy}>
                      Rename
                    </button>
                  </form>
                )}
                {current.kind === 'dm' && (
                  <p>This conversation is private to its two participants.</p>
                )}
                {current.kind === 'group' && (
                  <>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const userId = new FormData(e.currentTarget).get('userId');
                        void action(() =>
                          request('/conversations/' + current.id + '/invitations', 'POST', {
                            userId,
                          }),
                        );
                      }}
                    >
                      <label>
                        Invite a member
                        <select name="userId" required>
                          <option value="">Choose a friend</option>
                          {members
                            .filter((m) => !current.members.some((member) => member.id === m.id))
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button className="secondary" disabled={busy}>
                        Send invitation
                      </button>
                    </form>
                    <p>
                      New members cannot see earlier messages. Returning members can see their
                      previous membership periods, excluding messages sent while away.
                    </p>
                    {current.members.map((member) => (
                      <div className="account-row" key={member.id}>
                        <strong>
                          {member.displayName}
                          {member.id === current.managerId ? ' · Manager' : ''}
                        </strong>
                        {current.managerId === state.user.id && member.id !== state.user.id && (
                          <div className="account-actions">
                            <button
                              className="secondary"
                              disabled={busy || member.status !== 'approved'}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Transfer group management to ' + member.displayName + '?',
                                  )
                                )
                                  void action(() =>
                                    request(
                                      '/conversations/' + current.id + '/membership',
                                      'POST',
                                      { action: 'transfer', userId: member.id },
                                    ),
                                  );
                              }}
                            >
                              Make manager
                            </button>
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Remove ' + member.displayName + ' from this group?',
                                  )
                                )
                                  void action(() =>
                                    request(
                                      '/conversations/' + current.id + '/membership',
                                      'POST',
                                      { action: 'remove', userId: member.id },
                                    ),
                                  );
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm('Leave this group? You need a new invitation to return.')
                        )
                          void action(async () => {
                            await request('/conversations/' + current.id + '/membership', 'POST', {
                              action: 'leave',
                            });
                            setModal(null);
                          });
                      }}
                    >
                      Leave group
                    </button>
                  </>
                )}
              </>
            )
          )}
          {nextCategoryPage &&
            (modal === 'channel' || modal === 'manage' || modal === 'categories') && (
              <button
                className="secondary"
                disabled={categoriesBusy}
                onClick={() => void moreCategories()}
              >
                {categoriesBusy ? 'Loading categories…' : 'Load more categories'}
              </button>
            )}
        </div>
      </section>
    </div>
  );
}
