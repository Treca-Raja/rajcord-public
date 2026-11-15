import { runInBackground } from '../../shared/background';
import type { FormEvent } from 'react';
import type { AuthUser, Conversation } from '@tricord/shared';

export function NewDirectMessageDialog({
  members,
  userId,
  busy,
  create,
}: {
  members: AuthUser[];
  userId: string;
  busy: boolean;
  create: (event: FormEvent<HTMLFormElement>, kind: Conversation['kind']) => Promise<void>;
}) {
  return (
    <form onSubmit={(e) => runInBackground(create(e, 'dm'))}>
      <label>
        Member
        <select name="userId" required>
          {members
            .filter((m) => m.id !== userId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} (@{m.username})
              </option>
            ))}
        </select>
      </label>
      <button className="primary" disabled={busy}>
        Open conversation
      </button>
    </form>
  );
}
