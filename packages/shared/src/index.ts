export interface HealthResponse {
  status: 'ok';
  service: 'tricord-api';
  milestone: 1;
}
export interface ConnectionWelcome {
  message: string;
  connectedAt: string;
}
export interface ServerToClientEvents {
  'connection:welcome': (payload: ConnectionWelcome) => void;
}
export interface ClientToServerEvents {
  'connection:ping': (ack: (response: { ok: true }) => void) => void;
}
