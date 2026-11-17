import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthUser } from '@tricord/shared';
import { runInBackground } from '../../shared/background';
import { apiContract, useAuth } from './context';

export function PasswordRecoveryForm({
  back,
  completed,
}: {
  back: () => void;
  completed: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submitting = useRef(false),
    live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget,
      data = new FormData(form);
    const newPassword = String(data.get('newPassword'));
    if (newPassword !== data.get('confirmPassword')) {
      setError('The new passwords do not match.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await apiContract('/auth/password/reset', 'POST', {
        username: String(data.get('username')),
        code: String(data.get('code')).trim(),
        newPassword,
      });
      if (live.current) {
        form.reset();
        completed();
      }
    } catch (cause) {
      if (live.current) setError((cause as Error).message);
    } finally {
      submitting.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <>
      <h2>Reset your password</h2>
      <p>Ask the server owner for a recovery code. It expires after 15 minutes and works once.</p>
      <form onSubmit={(event) => runInBackground(submit(event))}>
        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            autoFocus
          />
        </label>
        <label>
          Recovery code
          <input
            name="code"
            autoComplete="one-time-code"
            spellCheck={false}
            autoCapitalize="none"
            required
            maxLength={128}
          />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <label>
          Confirm new password
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <p>Resetting your password signs out every device. Your account approval stays the same.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Resetting password…' : 'Reset password'}
        </button>
      </form>
      <button type="button" className="secondary" onClick={back}>
        Back to sign in
      </button>
    </>
  );
}

export function PasswordRecoveryIssuer({ target, close }: { target: AuthUser; close: () => void }) {
  const { requestContract } = useAuth();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const submitting = useRef(false),
    live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget,
      currentPassword = String(new FormData(form).get('currentPassword'));
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await requestContract(`/admin/password-recovery/${target.id}`, 'POST', {
        currentPassword,
      });
      if (live.current) {
        form.reset();
        setIssued(result);
      }
    } catch (cause) {
      if (live.current) setError((cause as Error).message);
    } finally {
      submitting.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section
      className="password-recovery-issuer"
      aria-label={'Password recovery for @' + target.username}
    >
      <h3>Password recovery for @{target.username}</h3>
      {issued ? (
        <>
          <p>
            Share this code privately with @{target.username}. It is shown only here and replaces
            any earlier code.
          </p>
          <label>
            Recovery code
            <input
              aria-label="Recovery code"
              readOnly
              value={issued.code}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p>
            Expires {new Date(issued.expiresAt).toLocaleTimeString()}. They can use{' '}
            <strong>Forgot password?</strong> on the sign-in screen. You never choose or see their
            new password.
          </p>
        </>
      ) : (
        <form onSubmit={(event) => runInBackground(submit(event))}>
          <p>
            Create a single-use code valid for 15 minutes. Verify who is asking before sharing it.
            Creating a code does not change their password or sign them out.
          </p>
          <label>
            Your current owner password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
              maxLength={128}
              autoFocus
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating code…' : 'Create recovery code'}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="secondary" onClick={close}>
        {issued ? 'Done' : 'Cancel recovery'}
      </button>
    </section>
  );
}
