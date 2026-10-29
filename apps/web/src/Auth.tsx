import { singleFlight } from './single-flight';
import {
  createContext,
  useMemo,
  useContext,
  useRef,
  useEffect,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  AuthState,
  AuthUser,
  ServerToClientEvents,
  ClientToServerEvents,
} from '@tricord/shared';
import { ShieldCheck, LogOut, X } from 'lucide-react';
type Context = {
  state: AuthState;
  connected: boolean;
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  openSettings: () => void;
};
const AuthContext = createContext<Context | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Authentication required');
  return value;
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status });
  return data as T;
}
export function AuthRoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null),
    [loading, setLoading] = useState(true),
    [connected, setConnected] = useState(false),
    [settings, setSettings] = useState(false),
    [error, setError] = useState('');
  const [liveSocket, setLiveSocket] = useState<Socket<
    ServerToClientEvents,
    ClientToServerEvents
  > | null>(null);
  const generation = useRef(0);
  const refresh = useMemo(
    () =>
      singleFlight(async () => {
        const started = generation.current;
        try {
          const next = await api<AuthState>('/auth/me');
          if (started === generation.current) setState(next);
        } catch (error) {
          if (started === generation.current && (error as { status?: number }).status === 401) {
            setState(null);
            setSettings(false);
          }
        } finally {
          setLoading(false);
        }
      }),
    [],
  );
  const broadcast = () => {
    const channel = new BroadcastChannel('tricord-account');
    channel.postMessage('changed');
    channel.close();
  };
  useEffect(() => {
    void refresh();
    const channel = new BroadcastChannel('tricord-account');
    channel.onmessage = () => void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    const timer = setInterval(focus, 60000);
    return () => {
      channel.close();
      window.removeEventListener('focus', focus);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!state) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      transports: ['websocket'],
      auth: { csrfToken: state.csrfToken },
      withCredentials: true,
    });
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLiveSocket(socket);
    socket.on('connect', () => {
      socket.emit('connection:ping', (value: { ok: boolean }) => setConnected(value.ok));
    });
    socket.on('account:changed', () => {
      void refresh();
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      void refresh();
      if (reason === 'io server disconnect' && active) socket.connect();
    });
    socket.on('connect_error', (error) => {
      setConnected(false);
      if (error.message === 'Sign in required.') void refresh();
      if (error.message === 'Authentication unavailable.' && active) {
        clearTimeout(retry);
        retry = setTimeout(() => socket.connect(), 2000);
      }
    });
    return () => {
      active = false;
      clearTimeout(retry);
      setLiveSocket(null);
      socket.removeAllListeners();
      socket.disconnect();
      setConnected(false);
    };
  }, [state?.csrfToken, state?.user.status, refresh]);
  const request = async <T,>(path: string, method = 'GET', body?: unknown) =>
    api<T>(path, method, body, state?.csrfToken);
  const logout = async () => {
    try {
      generation.current++;
      await request('/auth/logout', 'POST');
      setState(null);
      setSettings(false);
      broadcast();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    }
  };
  if (loading)
    return (
      <div className="auth-page">
        <p role="status">Opening your space…</p>
      </div>
    );
  if (!state)
    return (
      <SignIn
        onSignedIn={(value) => {
          generation.current++;
          setState(value);
          setError('');
          broadcast();
        }}
      />
    );
  const context: Context = {
    state,
    connected,
    socket: liveSocket,
    request,
    refresh,
    logout,
    openSettings: () => setSettings(true),
  };
  return (
    <AuthContext.Provider value={context}>
      {state.user.status === 'approved' ? (
        children
      ) : (
        <div className="auth-page">
          <section className="auth-card" data-account-status={state.user.status}>
            <div className="auth-mark">
              <ShieldCheck size={30} />
            </div>
            <div className="eyebrow">RAJCORD · YOUR ACCOUNT</div>
            <h1>
              {state.user.status === 'pending' ? 'You’re on the list.' : 'Registration declined.'}
            </h1>
            <p>
              {state.user.status === 'pending'
                ? 'An approved member needs to welcome you in. This page updates automatically when your account is approved.'
                : 'Your account was not approved. Private community features are unavailable.'}
            </p>
            <div className="account-identity">
              {state.user.displayName} <span>@{state.user.username}</span>
            </div>
            <button className="primary" onClick={() => void refresh()}>
              Check account status
            </button>
            <button className="secondary" onClick={() => setSettings(true)}>
              Account settings
            </button>
            <button className="text-button" onClick={() => void logout()}>
              Sign out
            </button>
          </section>
        </div>
      )}
      {error && (
        <div role="alert" className="auth-toast">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {settings && <AccountPanel close={() => setSettings(false)} />}
    </AuthContext.Provider>
  );
}
function SignIn({ onSignedIn }: { onSignedIn: (state: AuthState) => void }) {
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
          await api<AuthState>('/auth/login', 'POST', {
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
        <form onSubmit={(event) => void submit(event)} key={register ? 'register' : 'login'}>
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
type Device = {
  id: string;
  device_label: string;
  created_at: string;
  expires_at: string;
  remember: boolean;
  current: boolean;
};
type Audit = { id: string; actor: string; target: string; action: string; created_at: string };
function AccountPanel({ close }: { close: () => void }) {
  const { state, request, refresh, logout } = useAuth();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab') {
        const controls = panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        );
        if (!controls?.length) return;
        const first = controls[0]!,
          last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);

  const [tab, setTab] = useState('account'),
    [users, setUsers] = useState<AuthUser[]>([]),
    [sessions, setSessions] = useState<Device[]>([]),
    [history, setHistory] = useState<Audit[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    const data = await request<{ sessions: Device[] }>('/account/sessions');
    setSessions(data.sessions);
    if (state.user.status === 'approved') {
      const accounts = await request<{ users: AuthUser[] }>('/admin/accounts');
      setUsers(accounts.users);
      const audit = await request<{ history: Audit[] }>('/admin/history');
      setHistory(audit.history);
    }
  }
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, [state.user.status, state.user.isOwner]);
  async function run(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await work();
      setMessage(success);
      await refresh();
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={panel}
        className="account-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
      >
        <header>
          <div>
            <div className="eyebrow">YOUR RAJCORD</div>
            <h2>Settings & people</h2>
          </div>
          <button aria-label="Close settings" onClick={close}>
            <X />
          </button>
        </header>
        <nav className="account-tabs">
          <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>
            My account
          </button>
          {state.user.status === 'approved' && (
            <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
              People & approvals
            </button>
          )}
          <button onClick={() => void run(load, 'Updated.')}>Refresh</button>
        </nav>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        {tab === 'account' ? (
          <div className="account-content">
            <div className="account-identity">
              @{state.user.username}
              <span>
                {state.user.isOwner
                  ? 'Platform owner'
                  : state.user.status === 'approved'
                    ? 'Member · administrator'
                    : state.user.status}
              </span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const displayName = new FormData(e.currentTarget).get('displayName');
                void run(
                  () => request('/account', 'PATCH', { displayName }),
                  'Display name saved.',
                );
              }}
            >
              <label>
                Display name
                <input
                  name="displayName"
                  defaultValue={state.user.displayName}
                  required
                  maxLength={80}
                />
              </label>
              <button className="primary" disabled={busy}>
                Save name
              </button>
            </form>
            <h3>Change password</h3>
            <p>Changing your password signs out every device, including this one.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void run(
                  () =>
                    request('/account/password', 'POST', {
                      currentPassword: form.get('currentPassword'),
                      newPassword: form.get('newPassword'),
                    }),
                  'Password changed. Please sign in.',
                );
              }}
            >
              <label>
                Current password
                <input
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  name="newPassword"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
              <button className="secondary" disabled={busy}>
                Change password
              </button>
            </form>
            <h3>Signed-in devices</h3>
            {sessions.map((device) => (
              <div className="account-row" key={device.id}>
                <div>
                  <strong>
                    {device.device_label}
                    {device.current ? ' · This device' : ''}
                  </strong>
                  <small>
                    {device.remember ? 'Remembered' : 'Temporary'} · Expires{' '}
                    {new Date(device.expires_at).toLocaleString()}
                  </small>
                </div>
                <button
                  disabled={busy}
                  className="danger"
                  onClick={() =>
                    void run(
                      () => request('/account/sessions/' + device.id, 'DELETE'),
                      'Device signed out.',
                    )
                  }
                >
                  Sign out
                </button>
              </div>
            ))}
            <button className="secondary" onClick={() => void logout()}>
              <LogOut size={16} /> Sign out of Rajcord
            </button>
          </div>
        ) : (
          <div className="account-content">
            <p>
              Every approved member can review registrations. Only the platform owner can suspend or
              remove approved members.
            </p>
            {users.length === 0 && (
              <p className="empty-accounts">No pending registrations. You’re all caught up.</p>
            )}
            {users.map((user) => (
              <div className="account-row" key={user.id}>
                <div>
                  <strong>
                    {user.displayName}
                    {user.isOwner ? ' · Owner' : ''}
                  </strong>
                  <small>
                    @{user.username} · {user.status}
                  </small>
                </div>
                <div className="account-actions">
                  {user.id !== state.user.id && !user.isOwner && (
                    <>
                      {(user.status === 'pending'
                        ? ['approve', 'reject']
                        : state.user.isOwner && user.status === 'approved'
                          ? ['suspend', 'remove', 'transfer']
                          : state.user.isOwner && user.status === 'suspended'
                            ? ['restore', 'remove']
                            : []
                      ).map((action) => (
                        <button
                          key={action}
                          disabled={busy}
                          className={
                            ['remove', 'suspend', 'reject'].includes(action)
                              ? 'danger'
                              : 'secondary'
                          }
                          onClick={() => {
                            if (
                              ['remove', 'suspend', 'transfer'].includes(action) &&
                              !window.confirm(
                                action === 'transfer'
                                  ? 'Transfer ownership to @' +
                                      user.username +
                                      '? You will lose owner privileges.'
                                  : action +
                                      ' @' +
                                      user.username +
                                      '? Their sessions will be revoked.',
                              )
                            )
                              return;
                            void run(
                              () =>
                                action === 'transfer'
                                  ? request('/owner/transfer', 'POST', { userId: user.id })
                                  : request('/admin/accounts/' + user.id, 'POST', { action }),
                              'Account updated.',
                            );
                          }}
                        >
                          {action === 'transfer'
                            ? 'Make owner'
                            : action[0]!.toUpperCase() + action.slice(1)}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ))}
            <h3>Recent account decisions</h3>
            {history.map((row) => (
              <p className="audit-row" key={row.id}>
                <strong>@{row.actor}</strong> · {row.action} · @{row.target}
                <small>{new Date(row.created_at).toLocaleString()}</small>
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
