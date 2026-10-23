# Tricord architecture and security decisions

Updated 2026-10-23 for Milestone 2A. Foundation commit: 1576549. Active repository: F:\tricord.

## Scope and stack

One private community, up to ten friends. The existing React 19 / Vite 8 / Electron 45 / Fastify 5 / Socket.IO 4 / Drizzle / PostgreSQL 17 / pnpm monorepo is retained. TypeScript 6 remains compatible with typescript-eslint. Existing UI primitives and the community layout are reused.

New dependencies have specific jobs: Argon2 password hashing, Fastify cookies, rate limiting and built-asset serving. Browser verification uses Node's built-in WebSocket client with the [Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/), avoiding a browser automation dependency. No messaging, DM, channel persistence, media, deployment or complex roles were added.

## Account and owner model

Public registration always creates a pending user. Pending/rejected users can authenticate, view their own status, edit their account and revoke their own sessions; they cannot read the community member list, account queue or audit history, or use the approved socket event.

Every approved member can approve/reject pending accounts. Decisions record actor, target, action and timestamp. Owner-only operations are suspend/remove/restore approved accounts and transfer ownership. Self-actions and changes to the current owner are rejected; UUIDs are canonicalized before identity comparisons. Ownership transfer requires a different approved member. The old owner becomes an ordinary approved administrator.

A singleton database row designates the owner. An explicitly invoked local CLI creates a new owner account inside a transaction. Public registration never becomes owner, even when it is the first registration. Bootstrap refuses an initialized platform. No HTTP bootstrap endpoint exists. Operators must use an unused username; old rows without password credentials remain intact and cannot authenticate.

Account transitions, bootstrap, ownership changes, login and password changes serialize through a PostgreSQL advisory transaction lock. Authorization is rechecked inside transitions, protecting against concurrent approval/ownership races. Removal uses a status tombstone; it does not erase identity or audit history. Critical security configuration remains local operator configuration. No security-settings web API is exposed.

Administrative permissions never imply access to another person's private conversations. Private conversations do not yet exist; future membership and history rules need explicit authorization tests.

## Passwords and sessions

Argon2id uses 19 MiB memory, 2 iterations and parallelism 1, matching an [OWASP recommended baseline](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Passwords accept 12–128 characters, are not trimmed, and are never returned, logged or stored in plaintext. Usernames are ASCII letters/digits/underscores, 3–32 characters, normalized to lowercase with a database unique index. Display names are separate and rendered as text.

Unknown-account login attempts still perform Argon2 verification using a dummy hash; legacy accounts without credentials cannot match that dummy. Invalid credentials and suspended/removed accounts receive generic authentication failures. Registration returns a generic conflict but can reveal username availability; avoiding that completely would conflict with immediate unique-username registration feedback.

Sessions use 256-bit random tokens; the database stores SHA-256 token hashes. Each login creates a new token and revokes the previous cookie's session. The token is never exposed through JSON, preload or localStorage. A distinct random session-bound CSRF token is returned to the authenticated renderer and held in memory.

Cookies are HttpOnly, SameSite=Strict, host-only and Path=/. Local HTTP uses non-Secure cookies on loopback. NODE_ENV=production enables Secure and rejects non-HTTPS allowed origins. Temporary sessions expire after 12 hours and have session cookies; remembered sessions expire after 30 days with matching Max-Age. Expiry is absolute, not sliding.

Logout, device revocation and password changes revoke sessions in the database. Password changes require the existing password and revoke all devices. Suspension/removal revoke all sessions in the same transaction as the status change. Restoration never revives revoked sessions. Device lists expose only the caller's device metadata, not bearer tokens or other users' sessions.

## HTTP and Socket.IO boundaries

The browser uses same-origin /api and /socket.io. Vite proxies both during development; Fastify serves built assets locally otherwise. Origin allowlists contain explicit HTTP(S) origins. Null, file, missing and untrusted origins are rejected for mutations and socket handshakes. Authenticated mutations also require a matching X-CSRF-Token. Public login/registration mutations require trusted Origin, preventing login CSRF.

CORS is credentialed and allowlisted. API responses are no-store. Fastify adds nosniff, no-referrer and frame protection; the existing web CSP restricts scripts and network destinations. Request bodies are limited to 16 KiB. Inputs reject unknown privilege fields. Errors omit database details, hashes and secrets. Request bodies and cookies are not logged.

Registration is limited to 5 requests/minute/IP, login to 10, password changes to 5, with a 120/minute global HTTP limit. Limits are local to one process; reverse-proxy trust and shared limits must be deliberately designed before hosting.

Socket handshakes require the cookie, CSRF token and trusted Origin. Pending/rejected users join only their own account/session rooms and get status-change signals, never a private welcome or successful approved ping. Every protected event re-queries live session and status. Revocation disconnects affected sockets immediately on this server; an additional 15-second sweep closes expired or externally revoked sockets. Reconnecting clients and API requests always reauthenticate against PostgreSQL. Future private events must reuse these authorization boundaries; rooms alone are not authorization.

## Electron lifecycle

Electron preserves sandbox, contextIsolation, webSecurity and disabled nodeIntegration. Permission requests, new windows, renderer navigation and webviews are denied. The read-only preload exposes only platform/version. The app uses a single-instance lock, preventing a second launch from clearing the first instance's temporary session.

Development loads Vite's loopback origin. Built Electron loads the built UI served by Fastify at 127.0.0.1:3001, avoiding opaque file origins. A remote-server selector is out of scope.

Minimizing retains the session; closing the window fully quits because there is no tray implementation. On orderly quit, Electron revokes a temporary session through the authenticated API, clears its local cookie and flushes the cookie store. At startup it also discards any leftover temporary cookies. Remembered cookies remain. Cookie persistence semantics follow the [Electron cookies API](https://www.electronjs.org/docs/latest/api/cookies).

Offline/crash termination cannot guarantee server revocation. Temporary cookies are not restored by the app, but server-side remnants can live until expiry or explicit device revocation. This limit is documented, not represented as a verified online logout.

## Data preservation and testing

The initial migration and existing users are preserved. The new migration adds rejected/suspended/removed enum values, credential/session/audit tables, singleton owner designation and indexes. No volume or development database is reset. Migration reruns are idempotent.

Foundation database tests use unique disposable rows. Authentication/browser/desktop tests own newly created uniquely named test databases, which they migrate and delete after closing their connections. No test changes your real owner's credentials or role. Browser and Electron tests have isolated temporary profiles and disposable passwords created in memory; credentials are never written to reports. Test profiles are left under the OS temp directory for diagnostics; their server sessions become unusable when the test database is dropped.

The restart probe adds only its own fixture rows to the real local database, verifies persistence after Docker restart, then removes those exact records. It never drops databases, volumes or unrelated records.

## Before future hosting

Keep loopback binding for this milestone. HTTPS/reverse-proxy configuration, remote Electron origin selection, backups, account recovery, MFA, distributed rate limits/socket coordination, retention of expired sessions, abuse controls and external security review remain future work. In-process socket disconnects assume one API instance. Signed Windows packaging and updates are also outside this milestone.
