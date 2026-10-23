export type AccountStatus = 'pending' | 'approved' | 'rejected' | 'suspended' | 'removed';
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  status: AccountStatus;
  isOwner: boolean;
}
export interface AuthState {
  user: AuthUser;
  csrfToken: string;
  expiresAt: string;
  remember: boolean;
}
export interface HealthResponse {
  status: 'ok';
  service: 'tricord-api';
  milestone: 2;
}
export interface ConnectionWelcome {
  message: string;
  connectedAt: string;
}
export interface ServerToClientEvents {
  'connection:welcome': (payload: ConnectionWelcome) => void;
  'account:changed': () => void;
}
export interface ClientToServerEvents {
  'connection:ping': (ack: (response: { ok: boolean }) => void) => void;
}
