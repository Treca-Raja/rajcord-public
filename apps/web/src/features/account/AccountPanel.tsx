import { runInBackground } from '../../shared/background';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthUser } from '@tricord/shared';
import { X, LogOut } from 'lucide-react';
import { AppearancePreferences } from '../appearance';
import { useAuth, type SettingsTab } from './context';
import { PasswordRecoveryIssuer } from './PasswordRecovery';
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
  voiceHostRef,
}: {
  close: () => void;
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  notificationHostRef: (element: HTMLDivElement | null) => void;
  voiceHostRef: (element: HTMLDivElement | null) => void;
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
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        );
        const visible = [...(controls ?? [])].filter(
          (element) =>
            element.offsetParent !== null && element.tabIndex >= 0 && !element.matches(':disabled'),
        );
        if (!visible.length) return;
        const first = visible[0]!,
          last = visible[visible.length - 1]!;
        if (!panel.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
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
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const [users, setUsers] = useState<AuthUser[]>([]),
    [sessions, setSessions] = useState<Device[]>([]),
    [history, setHistory] = useState<Audit[]>([]),
    [message, setMessage] = useState(''),
    [messageFailed, setMessageFailed] = useState(false),
    [loadError, setLoadError] = useState(''),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const lifetime = useRef<object | null>(null);
  const operation = useRef(false);
  const loadRequest = useRef<AbortController | null>(null);
  const currentRequest = useRef(requestContract);
  currentRequest.current = requestContract;
  const busy = loading || saving;
  const [recoveryTarget, setRecoveryTarget] = useState<AuthUser | null>(null);
  const recoveryTrigger = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    setLoading(true);
    setLoadError('');
    try {
      const [data, accounts, audit] = await Promise.all([
        currentRequest.current('/account/sessions', 'GET', undefined, controller.signal),
        state.user.status === 'approved'
          ? currentRequest.current('/admin/accounts', 'GET', undefined, controller.signal)
          : Promise.resolve({ users: [] }),
        state.user.status === 'approved'
          ? currentRequest.current('/admin/history', 'GET', undefined, controller.signal)
          : Promise.resolve({ history: [] }),
      ]);
      if (controller.signal.aborted || loadRequest.current !== controller) return;
      setSessions(data.sessions);
      setUsers(accounts.users);
      setHistory(audit.history);
    } catch (cause) {
      if (!controller.signal.aborted && loadRequest.current === controller)
        setLoadError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted && loadRequest.current === controller) setLoading(false);
    }
  }, [state.user.status]);
  useEffect(() => {
    lifetime.current = {};
    operation.current = false;
    setSaving(false);
    setUsers([]);
    setSessions([]);
    setHistory([]);
    runInBackground(load());
    return () => {
      lifetime.current = null;
      loadRequest.current?.abort();
    };
  }, [load, state.user.isOwner]);
  async function run(work: () => Promise<unknown>, success: string) {
    if (busy || operation.current || !lifetime.current) return;
    const started = lifetime.current;
    operation.current = true;
    setSaving(true);
    setMessage('');
    setMessageFailed(false);
    try {
      await work();
      if (lifetime.current !== started) return;
      setMessage(success);
      await refresh();
      if (lifetime.current !== started) return;
      await load();
    } catch (e) {
      if (lifetime.current !== started) return;
      setMessageFailed(true);
      setMessage((e as Error).message);
    } finally {
      if (lifetime.current === started) {
        operation.current = false;
        setSaving(false);
      }
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
        <nav className="account-tabs" aria-label="Settings sections">
          {state.user.status === 'approved' && (
            <button
              aria-current={tab === 'voice' ? 'page' : undefined}
              className={tab === 'voice' ? 'active' : ''}
              onClick={() => setTab('voice')}
            >
              Voice & audio
            </button>
          )}
          <button
            aria-current={tab === 'account' ? 'page' : undefined}
            className={tab === 'account' ? 'active' : ''}
            onClick={() => setTab('account')}
          >
            My account
          </button>
          <button
            aria-current={tab === 'appearance' ? 'page' : undefined}
            className={tab === 'appearance' ? 'active' : ''}
            onClick={() => setTab('appearance')}
          >
            Appearance
          </button>
          {state.user.status === 'approved' && (
            <button
              aria-current={tab === 'notifications' ? 'page' : undefined}
              className={tab === 'notifications' ? 'active' : ''}
              onClick={() => setTab('notifications')}
            >
              Notifications
            </button>
          )}
          {state.user.status === 'approved' && (
            <button
              aria-current={tab === 'people' ? 'page' : undefined}
              className={tab === 'people' ? 'active' : ''}
              onClick={() => setTab('people')}
            >
              People & approvals
            </button>
          )}
          <button disabled={busy} onClick={() => runInBackground(load())}>
            Refresh
          </button>
        </nav>
        {message && (
          <p
            className={'form-message' + (messageFailed ? ' form-error' : '')}
            role={messageFailed ? 'alert' : 'status'}
          >
            {message}
          </p>
        )}
        {loading && (
          <p className="form-message" role="status">
            Loading account details…
          </p>
        )}
        {loadError && (
          <div className="form-message" role="alert">
            <span>Account details could not be loaded. {loadError}</span>{' '}
            <button disabled={busy} onClick={() => runInBackground(load())}>
              Retry
            </button>
          </div>
        )}
        {tab === 'voice' && state.user.status === 'approved' ? (
          <div className="account-content" ref={voiceHostRef} />
        ) : tab === 'appearance' ? (
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
            <button
              className="secondary"
              disabled={saving}
              onClick={() => runInBackground(logout())}
            >
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
            {!loading && !loadError && users.length === 0 && (
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
                  {state.user.isOwner && user.status === 'approved' && !user.isOwner && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={(event) => {
                        recoveryTrigger.current = event.currentTarget;
                        setRecoveryTarget(user);
                      }}
                    >
                      Reset password
                    </button>
                  )}
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
            {state.user.isOwner &&
              recoveryTarget &&
              users.some(
                (user) =>
                  user.id === recoveryTarget.id && user.status === 'approved' && !user.isOwner,
              ) && (
                <PasswordRecoveryIssuer
                  key={recoveryTarget.id}
                  target={recoveryTarget}
                  close={() => {
                    setRecoveryTarget(null);
                    if (recoveryTrigger.current?.isConnected) recoveryTrigger.current.focus();
                  }}
                />
              )}
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
