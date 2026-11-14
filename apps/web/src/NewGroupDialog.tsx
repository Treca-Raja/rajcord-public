import type { FormEvent } from 'react';
import type { AuthUser } from '@tricord/shared';

export function NewGroupDialog({
  members,
  userId,
  busy,
  create,
}: {
  members: AuthUser[];
  userId: string;
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form onSubmit={(e) => void create(e)}>
      <label>
        Group name
        <input autoFocus name="name" maxLength={80} required placeholder="The usual suspects" />
      </label>
      <p>Invite friends to join. Each person must accept before seeing messages.</p>
      {members
        .filter((m) => m.id !== userId)
        .map((m) => (
          <label className="check-label" key={m.id}>
            <input type="checkbox" name="userIds" value={m.id} />
            {m.displayName}
          </label>
        ))}
      <button className="primary" disabled={busy}>
        Create
      </button>
    </form>
  );
}
