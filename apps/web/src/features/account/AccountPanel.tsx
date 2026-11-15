import { runInBackground } from '../../shared/background';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@tricord/shared';
import { X, LogOut } from 'lucide-react';
import { AppearancePreferences } from '../appearance';
import { useAuth, type SettingsTab } from './context';
type Device = {
  id: string;
  device_label: string;
  created_at: string;
  expires_at: string;
  remember: boolean;
  current: boolean;
};
type Audit = { id: string; actor: string; target: string; action: string; created_at: string };
export function AccountPanel({
  close,
  tab,
  setTab,
  notificationHostRef,
}: {
  close: () => void;
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  notificationHostRef: (element: HTMLDivElement | null) => void;
}) {
  const { state, request, requestContract, refresh, logout } = useAuth();
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const controls = panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        );
        const visible = [...(controls ?? [])].filter((element) => element.offsetParent !== null);
        if (!visible.length) return;
        const first = visible[0]!,
          last = visible[visible.length - 1]!;
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

  const [users, setUsers] = useState<AuthUser[]>([]),
    [sessions, setSessions] = useState<Device[]>([]),
    [history, setHistory] = useState<Audit[]>([]),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const data = await requestContract('/account/sessions', 'GET');
    setSessions(data.sessions);
    if (state.user.status === 'approved') {
      const accounts = await requestContract('/admin/accounts', 'GET');
      setUsers(accounts.users);
      const audit = await requestContract('/admin/history', 'GET');
      setHistory(audit.history);
    }
  }, [requestContract, state.user.status]);
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, [load, state.user.isOwner]);
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
          <button
            className={tab === 'appearance' ? 'active' : ''}
            onClick={() => setTab('appearance')}
          >
            Appearance
          </button>
          {state.user.status === 'approved' && (
            <button
              className={tab === 'notifications' ? 'active' : ''}
              onClick={() => setTab('notifications')}
            >
              Notifications
            </button>
          )}
          {state.user.status === 'approved' && (
            <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
              People & approvals
            </button>
          )}
          <button onClick={() => runInBackground(run(load, 'Updated.'))}>Refresh</button>
        </nav>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        {tab === 'appearance' ? (
          <AppearancePreferences />
        ) : tab === 'notifications' && state.user.status === 'approved' ? (
          <div className="account-content notification-settings-slot" ref={notificationHostRef} />
        ) : tab === 'account' ? (
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
                runInBackground(
                  run(() => request('/account', 'PATCH', { displayName }), 'Display name saved.'),
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
                runInBackground(
                  run(
                    () =>
                      request('/account/password', 'POST', {
                        currentPassword: form.get('currentPassword'),
                        newPassword: form.get('newPassword'),
                      }),
                    'Password changed. Please sign in.',
                  ),
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
                    runInBackground(
                      run(
                        () => request('/account/sessions/' + device.id, 'DELETE'),
                        'Device signed out.',
                      ),
                    )
                  }
                >
                  Sign out
                </button>
              </div>
            ))}
            <button className="secondary" onClick={() => runInBackground(logout())}>
              <LogOut size={16} /> Sign out of Rajcord
            </button>
            <p className="font-credits">
              Inter typography & Twemoji artwork · self-hosted ·{' '}
              <a href="/font-licenses.txt" target="_blank" rel="noopener noreferrer">
                Font & emoji licenses
              </a>
            </p>
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
                            runInBackground(
                              run(
                                () =>
                                  action === 'transfer'
                                    ? request('/owner/transfer', 'POST', { userId: user.id })
                                    : request('/admin/accounts/' + user.id, 'POST', { action }),
                                'Account updated.',
                              ),
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
