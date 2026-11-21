import { runInBackground } from '../../shared/background';
import { useRef, useState, type FormEvent } from 'react';
import type { AuthState } from '@tricord/shared';
import { AppearanceBrand } from '../appearance';
import { api, apiContract } from './context';
import { PasswordRecoveryForm } from './PasswordRecovery';
export function SignIn({ onSignedIn }: { onSignedIn: (state: AuthState) => void }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const submitting = useRef(false);
  const [recover, setRecover] = useState(false);
  const recoveryTrigger = useRef<HTMLButtonElement>(null);
  const backToSignIn = () => {
    setRecover(false);
    requestAnimationFrame(() => recoveryTrigger.current?.focus());
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username')),
      password = String(form.get('password'));
    try {
      if (register) {
        await api('/auth/register', 'POST', {
          username,
          password,
          displayName: String(form.get('displayName')),
        });
        setRegister(false);
        setNotice('Account created. Sign in to see your approval status.');
      } else
        onSignedIn(
          await apiContract('/auth/login', 'POST', {
            username,
            password,
            remember: form.get('remember') === 'on',
            deviceLabel: window.tricordDesktop ? 'Rajcord for Windows' : 'Web browser',
          }),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <AppearanceBrand />
          <strong>Rajcord</strong>
        </div>
        {recover ? (
          <PasswordRecoveryForm
            back={backToSignIn}
            completed={() => {
              backToSignIn();
              setNotice('Password reset. Sign in with your new password.');
            }}
          />
        ) : (
          <>
            <h2>{register ? 'Create an account' : 'Welcome back.'}</h2>
            <p>
              {register
                ? 'A member of the group will approve your registration.'
                : 'Sign in with your account.'}
            </p>
            <form
              onSubmit={(event) => runInBackground(submit(event))}
              key={register ? 'register' : 'login'}
            >
              <label>
                Username
                <input
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_]{3,32}"
                  placeholder="your_username"
                />
              </label>
              {register && (
                <label>
                  Display name
                  <input
                    name="displayName"
                    autoComplete="nickname"
                    required
                    maxLength={80}
                    placeholder="What your friends call you"
                  />
                </label>
              )}
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={12}
                  maxLength={128}
                  placeholder={register ? 'At least 12 characters' : 'Your password'}
                />
              </label>
              {!register && (
                <label className="check-label">
                  <input name="remember" type="checkbox" />
                  Remember this device for 30 days
                </label>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {notice && !register && (
                <p className="form-success" role="status">
                  {notice}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}
              </button>
            </form>
            <p className="auth-switch">
              {register ? 'Already part of the group?' : 'New around here?'}{' '}
              <button
                disabled={busy}
                onClick={() => {
                  setRegister(!register);
                  setError('');
                  setNotice('');
                }}
              >
                {register ? 'Sign in' : 'Create an account'}
              </button>
            </p>
            <small className="auth-footnote">
              Your community is private. New accounts need member approval.
            </small>
            {!register && (
              <button
                ref={recoveryTrigger}
                type="button"
                disabled={busy}
                onClick={() => {
                  setRecover(true);
                  setError('');
                  setNotice('');
                }}
              >
                Forgot password?
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
