import { createContext, useContext, type Context as ReactContext } from 'react';
import type { AuthState, ServerToClientEvents, ClientToServerEvents } from '@tricord/shared';
import { validateApiRequest, validateApiResponse, InvalidApiResponseError } from '@tricord/shared';
import type {
  ApiClientPath,
  ApiMethodForPath,
  ApiRequestBodyFor,
  ApiResponseFor,
} from '@tricord/shared';
import type { Socket } from 'socket.io-client';
export type AuthContextValue = {
  state: AuthState;
  connected: boolean;
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  request: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  requestContract: <Path extends ApiClientPath, Method extends ApiMethodForPath<Path>>(
    path: Path,
    method: Method,
    body?: ApiRequestBodyFor<Path, Method>,
    signal?: AbortSignal,
  ) => Promise<ApiResponseFor<Path, Method>>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  notificationSettingsHost: HTMLDivElement | null;
};
export type SettingsTab = 'account' | 'people' | 'notifications' | 'appearance';
const hotContext: { authContext?: ReactContext<AuthContextValue | null> } | undefined = import.meta
  .hot?.data;
export const AuthContext = hotContext?.authContext ?? createContext<AuthContextValue | null>(null);
if (hotContext) hotContext.authContext = AuthContext;
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
  signal?: AbortSignal,
): Promise<T> {
  validateApiRequest(path, method, body);
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (!response.ok)
      throw Object.assign(new Error('Request failed.'), { status: response.status });
    throw new InvalidApiResponseError();
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : 'Request failed.',
      ),
      { status: response.status },
    );
  validateApiResponse(path, method, data);
  return data as T;
}

export function apiContract<Path extends ApiClientPath, Method extends ApiMethodForPath<Path>>(
  path: Path,
  method: Method,
  body?: ApiRequestBodyFor<Path, Method>,
  csrf?: string,
  signal?: AbortSignal,
): Promise<ApiResponseFor<Path, Method>> {
  return api<ApiResponseFor<Path, Method>>(path, method, body, csrf, signal);
}
