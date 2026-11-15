import { runInBackground } from '../../shared/background';
import { useState, type FormEvent } from 'react';
import type { AuthState } from '@tricord/shared';
import { ShieldCheck } from 'lucide-react';
import { api, apiContract } from './context';
export function SignIn({ onSignedIn }: { onSignedIn: (state: AuthState) => void }) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-intro">
        <div className="logo">
          t<span>•</span>
        </div>
        <div className="eyebrow">YOUR PEOPLE, YOUR PLACE</div>
        <h1>
          A little space
          <br />
          of our own.
        </h1>
        <p>
          Good conversations. Familiar faces.
          <br />A private corner for your group.
        </p>
        <span className="auth-tag">
          <ShieldCheck size={16} /> One community. Made for friends.
        </span>
      </div>
      <section className="auth-card">
        <h2>{register ? 'Find your people.' : 'Welcome back.'}</h2>
        <p>
          {register
            ? 'Create an account. A member of the group will approve your registration.'
            : 'Sign in to your Rajcord community.'}
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
      </section>
    </main>
  );
}
