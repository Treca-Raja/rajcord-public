# Tricord architecture and security decisions

Updated 2026-10-24 for Milestone 2B; Milestone 2A commit b81b485 retained. Foundation commit: 1576549. Active repository: F:\tricord.

## Scope and stack

One private community, up to ten friends. The existing React 19 / Vite 8 / Electron 45 / Fastify 5 / Socket.IO 4 / Drizzle / PostgreSQL 17 / pnpm monorepo is retained. TypeScript 6 remains compatible with typescript-eslint. Existing UI primitives and the community layout are reused.

Milestone 2A dependencies have specific jobs: Argon2 password hashing, Fastify cookies, rate limiting and built-asset serving. Browser verification uses Node's built-in WebSocket client with the [Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/), avoiding a browser automation dependency. Milestone 2B adds messaging without new dependencies. Media, deployment and complex roles remain out of scope.

## Account and owner model

Public registration always creates a pending user. Pending/rejected users can authenticate, view their own status, edit their account and revoke their own sessions; they cannot read the community member list, account queue or audit history, or use the approved socket event.

Every approved member can approve/reject pending accounts. Decisions record actor, target, action and timestamp. Owner-only operations are suspend/remove/restore approved accounts and transfer ownership. Self-actions and changes to the current owner are rejected; UUIDs are canonicalized before identity comparisons. Ownership transfer requires a different approved member. The old owner becomes an ordinary approved administrator.

A singleton database row designates the owner. An explicitly invoked local CLI creates a new owner account inside a transaction. Public registration never becomes owner, even when it is the first registration. Bootstrap refuses an initialized platform. No HTTP bootstrap endpoint exists. Operators must use an unused username; old rows without password credentials remain intact and cannot authenticate.

Account transitions, bootstrap, ownership changes, login and password changes serialize through a PostgreSQL advisory transaction lock. Authorization is rechecked inside transitions, protecting against concurrent approval/ownership races. Removal uses a status tombstone; it does not erase identity or audit history. Critical security configuration remains local operator configuration. No security-settings web API is exposed.

Administrative permissions never imply access to another person's private conversations. DM/group access, membership history and author permissions are checked in the backend and exercised through independent authenticated sessions.

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

The initial migration and existing users are preserved. Milestone 2A migration 0001 added rejected/suspended/removed enum values, credential/session/audit tables, singleton owner designation and indexes. Milestone 2B migration 0002 adds messaging without rewriting 0000 or 0001. No volume or development database is reset. Migration reruns are idempotent.

Foundation database tests use unique disposable rows. Authentication/browser/desktop tests own newly created uniquely named test databases, which they migrate and delete after closing their connections. No test changes your real owner's credentials or role. Browser and Electron tests have isolated temporary profiles and disposable passwords created in memory; credentials are never written to reports. Test profiles are left under the OS temp directory for diagnostics; their server sessions become unusable when the test database is dropped.

The restart probe creates its own disposable database, verifies messaging/authentication persistence and existing-pool recovery after restarting the PostgreSQL container, then drops only that test database. It also verifies the original development migration journal is unchanged. It never deletes development data or volumes.

## Before future hosting

Keep loopback binding for this milestone. HTTPS/reverse-proxy configuration, remote Electron origin selection, backups, account recovery, MFA, distributed rate limits/socket coordination, retention of expired sessions, abuse controls and external security review remain future work. In-process socket disconnects assume one API instance. Signed Windows packaging and updates are also outside this milestone.

## Persistent messaging and membership boundaries

Migration 0002 adds conversations, membership periods, invitations and messages; the two applied migrations remain unchanged. A unique index and pair-shape constraint enforce one canonical unordered DM pair. Groups and DMs use explicit membership. Channels are shared by all approved accounts. Archived channels keep history but reject new sends.

A conversation-local bigint sequence orders messages. Acceptance opens a membership period at lastSeq + 1; leaving/removal closes it at lastSeq. Empty periods are valid. History requires current membership and restricts each message to the union of that user's periods. The same predicate applies to pagination, individual IDs and changes. Original timestamps and client clocks never determine visibility. Rejoining grants prior periods, not gaps. Unauthorized private IDs return the same 404 as absent records.

Chat operations reuse the authentication advisory transaction lock and conversation row lock, so status, membership boundaries and sends serialize. This favors correctness for ten friends over throughput. It is not a design for a large public server. A future blocking policy has one contact-check boundary for DM creation/sending and invitations.

The client supplies a UUID for an attempted send; a unique conversation/author/client-ID key makes retries idempotent. A hash of the original request detects conflicting reuse without retaining deleted text. Acknowledgment follows commit. Every new send increments both sequence and change counters; edits/deletes increment change only. Changes return current state, not every historical edit. Deletion clears body and returns only a tombstone during change synchronization; ordinary history/direct lookups never expose deleted content.

## Messaging API and realtime contract

All routes require a live approved session. Mutations retain trusted Origin and session-bound CSRF checks.

| Route                                                       | Behavior                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET/POST /api/conversations                                 | List authorized conversations; create channel/group or open canonical DM |
| GET/PATCH /api/conversations/:id                            | Read metadata; rename/manage permitted conversations                     |
| GET/POST /api/conversations/:id/messages                    | Paginated history; persist a send with body/clientId                     |
| GET/PATCH/DELETE /api/conversations/:id/messages/:messageId | Authorized lookup; author-only edit/delete                               |
| GET /api/invitations                                        | The caller's pending invitations                                         |
| POST /api/conversations/:id/invitations                     | Current member invites an approved user                                  |
| POST /api/invitations/:id                                   | Invitee accepts or declines                                              |
| POST /api/conversations/:id/membership                      | Leave, manager removal or manager transfer                               |

History uses limit (1–100), before for older sequence pages, or afterChange for ascending revision synchronization; cursors are decimal strings, not JavaScript numbers. Message IDs, sequence and original authorship remain stable. The client merges by ID/revision, handles repeated signals, and resynchronizes on reconnect/focus without resurrecting stale content.

Socket conversation:join authorizes the selected subscription. message:send uses the same transactional send path and returns an explicit success/error acknowledgment. conversation:changed and conversation:closed contain only a conversation ID; inbox:changed is a content-free metadata refresh signal. Actual message content is fetched through authorized history APIs. Delivery checks live status, membership and message-period visibility; a room is never an authorization decision. Pending/rejected sockets retain only the existing account-status flow.

Message text is rendered as React text, never HTML. Message content is limited to 4,000 characters; client author IDs and unknown fields are rejected. The database enforces 30 new messages/minute/author across HTTP and socket transports; retries do not consume that quota. HTTP mutations and socket events have additional 60/minute limits.

## Development lifecycle fixes

Expected idle PostgreSQL restart/disconnect errors are handled without credential-bearing error output; pg discards failed clients and reconnects on the next request. Readiness reflects outages. Writes are never blindly retried. Unexpected idle failures emit a generic warning.

The desktop development supervisor treats the named desktop process as the successful completion condition, while stopping API/Vite helpers. Regression tests exercise normal exit, desktop failure and an early helper failure.

AuthRoot owns one socket. Overlapping auth/me refreshes share one in-flight request, while later refreshes are never cached. Refresh generations prevent stale responses overwriting a newer login/logout. Network failures do not pretend the account logged out; real authorization failures clear access.

## Milestone 2C voice architecture

Community voice channels are persisted in additive migration 0003 with a default “The lounge.” Active reservations remain ephemeral and single-process: one reservation per account, tied to its existing authentication session. Concurrent joins serialize, and a second device receives a conflict. Room capacity is ten. No text-message schema or applied migration is rewritten.

LiveKit 1.13.10 is pinned in a separate Compose file; the browser client is loaded only when connecting to voice. API dependencies are livekit-server-sdk, @livekit/protocol and ws (plus ws types). They provide media control, protocol-aware token redaction and the signaling gateway. No media content is stored.

[Self-hosted LiveKit does not revoke cached tokens when a participant is removed](https://docs.livekit.io/frontends/reference/tokens-grants/). Therefore, clients never receive a usable LiveKit JWT. They receive an opaque reservation ID bound to their HttpOnly Tricord session. The same-origin /media/rtc gateway validates Origin, current approval, session identity, reservation and expiration, then creates a 60-second internal microphone-only JWT. Refresh-token responses are decoded and replaced with the opaque ID. No bearer token enters localStorage or diagnostics. Reconnection repeats authorization. The control endpoint is loopback-only and is not a public entry point.

A one-second authorization sweep removes expired/revoked participants through LiveKit and closes signaling. Account mutation responses also trigger reconciliation. If a database check fails, reservations fail closed, signaling closes, and media removal is retried. A new join cannot replace an existing account reservation until removal completes. Media-service/network outages can delay remote cleanup, so this is not a claim of instantaneous revocation under arbitrary service failure.

Reservations renew every ten seconds and expire after 45 seconds. Authenticated recovery can acquire a new reservation after expiry; a conflict on another device stops recovery. The first join after an API restart clears stale Tricord media rooms before admitting new reservations. A dedicated prefix isolates each automated test's rooms. The design explicitly assumes one API process; multi-process coordination remains future work.

Docker RTC advertises 127.0.0.1 with loopback candidate collection disabled inside the container. Enabling container loopback candidates produced duplicate addresses and failed ICE negotiation on Docker Desktop; the corrected configuration was verified with real bidirectional audio. [LiveKit's configuration reference](https://github.com/livekit/livekit/blob/v1.13.10/config-sample.yaml) describes the NAT address and candidate controls. Host port bindings remain loopback-only. Client ICE servers are empty for this local-only milestone.

Exact user-selected input IDs are captured as user-provided tracks, preventing SDK device fallback. Incoming audio uses application-owned media elements: initially muted, routed with setSinkId, and played only after routing succeeds. This avoids SDK automatic playback briefly using the default speakers. Device loss stops capture or mutes playback without selecting replacements. The OS notification boundary and physical device behavior require further validation.

Electron keeps its sandbox, isolated context, disabled renderer Node integration and restrictive navigation. Only top-frame audio requests from the exact app origin may prompt for native microphone consent. Camera/display capture and foreign/subframe requests remain denied. Permission is remembered only for the running process. Fake media is enabled solely by the existing isolated smoke harness. The [Electron permission documentation](https://www.electronjs.org/docs/latest/api/session) defines the request/check handlers used here.

Current scope excludes private/group calls, ringing, voice channel rename/archive UI, push-to-talk, advanced processing controls, global hotkeys, recording, streaming, mobile browser certification, TURN/WAN, cloud hosting and E2EE. Two synthetic clients verify transport and controls, not human listening quality or ten-user capacity benchmarks.
