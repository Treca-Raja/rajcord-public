import { runInBackground } from '../shared/background';
import { singleFlight } from '../shared/single-flight';
import { CallProvider } from './CallProvider';
import { VerifiedVoiceSessions } from '../features/voice/composition';
import type { ApprovedVoiceSession } from '../features/voice/contracts';
import {
  AuthContext,
  api,
  apiContract,
  SignIn,
  AccountPanel,
  type SettingsTab,
  type AuthContextValue,
} from '../features/account';
export { useAuth, api } from '../features/account';
import { screenSocketFactory } from '../features/screen-sharing/composition';
import type { ScreenApplication } from '../features/screen-sharing/contracts';
import { useCallback, useMemo, useRef, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AuthState, ServerToClientEvents, ClientToServerEvents } from '@tricord/shared';
import type { ApiClientPath, ApiMethodForPath, ApiRequestBodyFor } from '@tricord/shared';
import { ShieldCheck } from 'lucide-react';
import { FeatureBoundary } from '../shared/FeatureBoundary';
export function AuthRoot({
  children,
  screenApplication,
}: {
  children: ReactNode;
  screenApplication?: ScreenApplication;
}) {
  const [state, setState] = useState<AuthState | null>(null),
    [loading, setLoading] = useState(true),
    [connected, setConnected] = useState(false),
    [settings, setSettings] = useState<{ tab: SettingsTab; returnFocusTo?: HTMLElement } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [refreshError, setRefreshError] = useState(''),
    [refreshing, setRefreshing] = useState(false);
  const [liveSocket, setLiveSocket] = useState<Socket<
    ServerToClientEvents,
    ClientToServerEvents
  > | null>(null);
  const generation = useRef(0);
  const [notificationSettingsHost, setNotificationSettingsHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [voiceSettingsHost, setVoiceSettingsHost] = useState<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  const logoutGeneration = useRef<number | null>(null);
  const verifiedAuth = useRef<Readonly<{ account: string; csrf: string }> | null>(null);
  const knownSignedOut = useRef(false);
  const sessions = useRef(new VerifiedVoiceSessions());
  const [callSession, setCallSession] = useState<ApprovedVoiceSession | null>(null);
  function acceptVerified(next: AuthState | null) {
    knownSignedOut.current = next === null;
    const csrf = next?.csrfToken;
    if (!next) verifiedAuth.current = null;
    else if (verifiedAuth.current?.account !== next.user.id || verifiedAuth.current.csrf !== csrf) {
      verifiedAuth.current = { account: next.user.id, csrf: next.csrfToken };
    }
    // Bind cleanup requests to this verified session's CSRF, never a replacement's credentials.
    setCallSession(
      sessions.current.acceptVerified(
        next,
        <T,>(path: string, method?: string, body?: unknown) => api<T>(path, method, body, csrf),
        next ? screenSocketFactory(next.csrfToken) : undefined,
      ),
    );
    setState(next);
  }
  const refresh = useMemo(() => {
    let flight: { generation: number; run: () => Promise<void> } | undefined;
    return () => {
      if (!mounted.current) return Promise.resolve();
      const started = generation.current;
      if (flight?.generation === started) return flight.run();
      const run = singleFlight(async () => {
        setRefreshing(true);
        try {
          const next = await apiContract('/auth/me', 'GET');
          if (started === generation.current && logoutGeneration.current !== started) {
            acceptVerified(next);
            setRefreshError('');
          }
        } catch (error) {
          if (started === generation.current) {
            if ((error as { status?: number }).status === 401) {
              acceptVerified(null);
              setSettings(null);
              setRefreshError('');
            } else if (logoutGeneration.current !== started && !knownSignedOut.current)
              setRefreshError('Could not check your account. Check your connection and try again.');
          }
        } finally {
          if (started === generation.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      });
      flight = { generation: started, run };
      return run();
    };
  }, []);
  const broadcast = () => {
    const channel = new BroadcastChannel('tricord-account');
    channel.postMessage('changed');
    channel.close();
  };
  useEffect(() => {
    mounted.current = true;
    const lifetimeSessions = sessions.current;
    runInBackground(refresh());
    const channel = new BroadcastChannel('tricord-account');
    channel.onmessage = () => runInBackground(refresh());
    const focus = () => runInBackground(refresh());
    const suspend = () => {
      lifetimeSessions.invalidate();
      setCallSession(null);
    };
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', focus);
    const timer = setInterval(focus, 60000);
    return () => {
      mounted.current = false;
      verifiedAuth.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate the current async generation; this is not a DOM ref.
      generation.current++;
      lifetimeSessions.invalidate();
      channel.close();
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', focus);
      clearInterval(timer);
    };
  }, [refresh]);
  const csrfToken = state?.csrfToken;
  const accountStatus = state?.user.status;
  useEffect(() => {
    if (!csrfToken) return;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      transports: ['websocket'],
      auth: { csrfToken },
      withCredentials: true,
    });
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLiveSocket(socket);
    socket.on('connect', () => {
      socket.emit('connection:ping', (value: { ok: boolean }) => setConnected(value.ok));
      // Account changes can occur before the socket joins its notification room.
      runInBackground(refresh());
    });
    socket.on('account:changed', () => {
      runInBackground(refresh());
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      runInBackground(refresh());
      if (reason === 'io server disconnect' && active) socket.connect();
    });
    socket.on('connect_error', (error) => {
      setConnected(false);
      if (error.message === 'Sign in required.') runInBackground(refresh());
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
  }, [csrfToken, accountStatus, refresh]);
  const request = useCallback(
    <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
      api<T>(path, method, body, csrfToken, signal),
    [csrfToken],
  );
  const requestContract = useCallback(
    <Path extends ApiClientPath, Method extends ApiMethodForPath<Path>>(
      path: Path,
      method: Method,
      body?: ApiRequestBodyFor<Path, Method>,
      signal?: AbortSignal,
    ) => apiContract(path, method, body, csrfToken, signal),
    [csrfToken],
  );
  const logoutLifetime = verifiedAuth.current;
  const logout = async () => {
    if (!mounted.current || !logoutLifetime || verifiedAuth.current !== logoutLifetime) return;
    // Consume this verified lifetime before any reentrant/stale intention can affect another one.
    verifiedAuth.current = null;
    const started = ++generation.current;
    logoutGeneration.current = started;
    sessions.current.invalidate();
    setCallSession(null);
    try {
      await api('/auth/logout', 'POST', undefined, logoutLifetime.csrf);
      if (started !== generation.current) return;
      // Verification begun during logout cannot restore the retired session.
      generation.current++;
      logoutGeneration.current = null;
      acceptVerified(null);
      setSettings(null);
      setRefreshError('');
      setRefreshing(false);
      broadcast();
    } catch (e) {
      if (started !== generation.current) return;
      logoutGeneration.current = null;
      setError((e as Error).message);
      await refresh();
    }
  };
  const notice = error && (
    <div role="alert" className="auth-toast">
      {error}
      <button onClick={() => setError('')}>Dismiss</button>
    </div>
  );
  if (loading)
    return (
      <div className="auth-page">
        <p role="status">Opening your space…</p>
      </div>
    );
  if (!state && refreshError)
    return (
      <div className="auth-page">
        <section className="auth-card">
          <h1>Could not open Rajcord</h1>
          <p role="alert">{refreshError}</p>
          <button
            className="primary"
            disabled={refreshing}
            onClick={() => runInBackground(refresh())}
          >
            {refreshing ? 'Checking account…' : 'Retry'}
          </button>
        </section>
      </div>
    );
  if (!state)
    return (
      <>
        <SignIn
          onSignedIn={(value) => {
            if (!mounted.current) return;
            generation.current++;
            logoutGeneration.current = null;
            acceptVerified(value);
            setError('');
            setRefreshError('');
            setRefreshing(false);
            broadcast();
          }}
        />
        {notice}
      </>
    );
  function openSettings(tab: SettingsTab = 'account', returnFocusTo?: HTMLElement) {
    setSettings({ tab, returnFocusTo });
  }
  const context: AuthContextValue = {
    state,
    connected,
    socket: liveSocket,
    request,
    requestContract,
    refresh,
    logout,
    openSettings,
    notificationSettingsHost,
    voiceSettingsHost,
  };
  return (
    <AuthContext.Provider value={context}>
      {state.user.status === 'approved' ? (
        <CallProvider session={callSession} screenApplication={screenApplication}>
          {children}
        </CallProvider>
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
            <button
              className="primary"
              disabled={refreshing}
              onClick={() => runInBackground(refresh())}
            >
              Check account status
            </button>
            <button className="secondary" onClick={() => openSettings()}>
              Account settings
            </button>
            <button className="text-button" onClick={() => runInBackground(logout())}>
              Sign out
            </button>
          </section>
        </div>
      )}
      {refreshError && (
        <div role="alert" className="auth-toast">
          {refreshError}
          <button disabled={refreshing} onClick={() => runInBackground(refresh())}>
            Retry
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="auth-toast">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {settings && (
        <FeatureBoundary name="Account settings" onClose={() => setSettings(null)}>
          <AccountPanel
            key={state.user.id + ':' + state.csrfToken}
            tab={settings.tab}
            setTab={(tab) => setSettings((current) => current && { ...current, tab })}
            returnFocusTo={settings.returnFocusTo}
            notificationHostRef={setNotificationSettingsHost}
            voiceHostRef={setVoiceSettingsHost}
            close={() => setSettings(null)}
          />
        </FeatureBoundary>
      )}
    </AuthContext.Provider>
  );
}
