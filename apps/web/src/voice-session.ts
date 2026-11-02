import type { AuthState } from '@tricord/shared';

export type VoiceRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

// A local lifetime derived only from AuthRoot's verified responses, never a server grant.
export class ApprovedVoiceSession {
  private active = true;
  private listeners = new Set<() => void>();
  constructor(private currentRequest: VoiceRequest) {}

  get current() {
    return this.active;
  }
  request: VoiceRequest = (...args) => this.currentRequest(...args);
  updateRequest(request: VoiceRequest) {
    this.currentRequest = request;
  }
  onEnd(listener: () => void) {
    if (!this.active) listener();
    else this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  invalidate() {
    if (!this.active) return;
    this.active = false;
    const listeners = [...this.listeners];
    this.listeners.clear();
    listeners.forEach((listener) => listener());
  }
}

export class VerifiedVoiceSessions {
  private session: ApprovedVoiceSession | null = null;
  private identity?: { account: string; csrf: string };
  private expiry?: ReturnType<typeof setTimeout>;

  acceptVerified(state: AuthState | null, request: VoiceRequest) {
    const expiresAt = state ? Date.parse(state.expiresAt) : 0;
    const remaining = expiresAt - Date.now();
    if (
      !state ||
      state.user.status !== 'approved' ||
      !Number.isFinite(remaining) ||
      remaining <= 0
    ) {
      this.invalidate();
      return null;
    }
    if (
      !this.session?.current ||
      this.identity?.account !== state.user.id ||
      this.identity.csrf !== state.csrfToken
    ) {
      this.invalidate();
      this.identity = { account: state.user.id, csrf: state.csrfToken };
      this.session = new ApprovedVoiceSession(request);
    } else this.session.updateRequest(request);
    clearTimeout(this.expiry);
    const session = this.session;
    // Browser timers clamp delays above a signed 32-bit integer (remembered sessions last 30 days).
    const checkExpiry = () => {
      if (this.session !== session) return;
      const left = expiresAt - Date.now();
      if (left <= 0) this.invalidate();
      else this.expiry = setTimeout(checkExpiry, Math.min(left, 2_147_483_647));
    };
    checkExpiry();
    return session;
  }
  invalidate() {
    const session = this.session;
    this.session = null;
    this.identity = undefined;
    clearTimeout(this.expiry);
    session?.invalidate();
  }
}
