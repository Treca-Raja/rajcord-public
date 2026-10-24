# Milestone 2B verification

Windows 11, 2026-10-24. Repository: F:\tricord. Milestone 2A commit b81b485 retained.

| Check                                         | Result                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                                    | Existing postgres:17-alpine container healthy, bound only to 127.0.0.1:5432                                                      |
| Migrations                                    | Original 0000/0001 unchanged; additive 0002 applied; nine expected public tables                                                 |
| Migration reruns                              | Repeated execution leaves schema, journal and fixtures unchanged; generation detects no schema drift                             |
| Persistence                                   | Channels, DMs, group membership windows, messages, invitations, credentials, sessions and audit survive actual container restart |
| Foundation suite                              | 4 passing tests                                                                                                                  |
| Database suite                                | 7 passing tests                                                                                                                  |
| Authentication/security suite                 | 29 passing tests                                                                                                                 |
| Messaging suite                               | 29 passing tests                                                                                                                 |
| Client/pool/development lifecycle regressions | 8 passing tests                                                                                                                  |
| Total Vitest tests                            | **77 passing tests**                                                                                                             |
| Browser integration                           | Actual headless Edge; 11 authentication and 11 messaging checks                                                                  |
| Electron integration                          | Three actual launches; 17 authentication/lifecycle/messaging checks                                                              |
| Static checks/builds                          | Formatting, ESLint, TypeScript and all production builds pass                                                                    |
| Dependencies                                  | No dependencies added; peer checks and production audit pass                                                                     |

## Automated coverage

Authentication coverage from Milestone 2A remains: registration, hashing, session/cookie/CSRF/origin checks, approvals, ownership, account state transitions, device revocation, expiry, protected sockets and live suspension.

Messaging tests use real PostgreSQL and independent authenticated HTTP/Socket.IO sessions. Coverage includes channel creation/rename/archive, ordered concurrent sends, history pagination, idempotent retries and conflicting IDs, canonical DM pairs and nonparticipant privacy, explicit invitation acceptance/decline, unapproved/wrong-user denial, manager-only removal/transfer, leave/rejoin membership windows, direct-ID and pagination privacy, timestamp-independent ordering, empty membership periods, author-only edits/deletes, deleted-content removal, literal untrusted text, validation, account status, CSRF, persisted socket acknowledgments, unauthorized rooms, stale-room removal, suspension disconnect, missed edits/deletes on reconnect, backend restart and message quotas. A historical edit outside a new member's visible period must neither reveal content nor evict that member from subsequent authorized updates.

Client regressions cover in-flight auth request coalescing and later refreshes, revision-aware message merging, tombstones, pool error handling, and real supervisor subprocess exit codes for normal desktop exit, desktop failure and early helper failure.

## Browser evidence

Real headless Microsoft Edge runs the production build with an isolated temporary profile and disposable database. Existing registration, approval, cookie, account administration, reload and suspension checks remain.

Messaging checks send through the rendered composer, verify persistence, receive a reply from an independent account, render HTML-like input as text, edit/delete as author, open a DM, switch conversations, accept a group invitation, hide pre-join content, preserve history on reload and check responsive layout. Desktop and 390-pixel mobile screenshots are captured and visually reviewed.

Ignored reports: artifacts/auth-browser.json and artifacts/messaging-browser.json. Screenshots include messaging-browser-channel.png, messaging-browser-group.png and messaging-browser-mobile.png. This verifies Chromium/Edge on Windows, not Safari/Firefox or a physical mobile device.

## Electron evidence

Three actual sandboxed Electron launches use a temporary profile and disposable database. They verify registration, live approval, account settings, logout, minimize behavior, temporary-session cleanup and remembered-session restoration. The rendered composer sends a persisted message and receives an independent account's reply; both remain after restarting the application.

Renderer Node/process access remains unavailable, the preload remains narrow and localStorage contains no tokens. Ignored report: artifacts/auth-desktop.json. Crash/offline limitations remain documented in README.

## Restart and preservation

The persistence probe creates its own disposable database and fixture users, channels, DM, group invitation/membership periods and messages. It keeps existing Fastify/pg pools open across an actual Docker Compose PostgreSQL restart, checks readiness recovery, then verifies identity, ordering, privacy, idempotent retries and a subsequent send. It checks that the original development migration journal is unchanged and drops only its own test database.

The existing development database, users, sessions, audit records, applied migrations and named volume are preserved. PostgreSQL remains running after verification. No production deployment, publishing or push occurred.

Use the exact PowerShell commands in [README](../README.md). Prior milestone evidence remains in Git. Reports contain no credentials.

## Remaining limits

Single API process, intended for ten friends; serialized database authorization favors correctness over throughput. No end-to-end encryption, durable offline message queue, unread counters, blocking UI, uploads, search, voice/video/streaming, cloud deployment or signed installer. A database operator can read stored messages, while application administrators cannot access other participants' private conversations.
