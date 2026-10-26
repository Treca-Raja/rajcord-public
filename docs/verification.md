# Milestone 2C verification

Windows 11, 2026-10-24. Active repository: F:\tricord. Milestone 2B commit d298aa9 retained.

| Check                      | Result                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                 | Healthy existing PostgreSQL 17 service; 127.0.0.1:5432 only                                                      |
| LiveKit                    | Pinned 1.13.10 local container; control/TCP/UDP ports bound only to 127.0.0.1                                    |
| Migrations                 | 0000–0002 unchanged; additive 0003 creates voice_channels and seeds The lounge                                   |
| Schema                     | Ten public tables; repeat migration execution is safe; generation reports no drift                               |
| Unit/regression tests      | 24 passing                                                                                                       |
| Database integration tests | 80 passing: 7 database, 29 authentication, 29 messaging, 15 voice                                                |
| Total Vitest tests         | **104 passing**                                                                                                  |
| Existing Edge checks       | 22 authentication/messaging checks preserved                                                                     |
| Voice Edge checks          | 17 checks using two independent real Edge processes and synthetic audio                                          |
| Electron checks            | 23 across three actual launches, including real microphone publication and camera denial                         |
| Persistence                | Actual PostgreSQL restart preserves voice channels and existing messaging/authentication fixtures; pools recover |
| Static verification        | Formatting, lint, TypeScript and production builds pass                                                          |
| Dependency verification    | Peer checks and production audit pass                                                                            |

## Real voice evidence

The browser smoke creates a disposable PostgreSQL database, unique LiveKit room prefix and two isolated Edge profiles. Both approved accounts select concrete fake devices through the rendered controls, join muted, unmute and receive actual audio bytes through the media server. Its synthetic WAV input is generated in the temporary test profile; it never opens a physical microphone.

Checks cover session separation, explicit input/output selection, bidirectional audio, microphone-only server grants, mute propagation, deafen playback suppression, signaling reconnect, retained mute preference, simulated microphone loss without fallback, suspension removal, cached-credential rejection, manual leave, expired-reservation recovery, actual Fastify API restart and both clients recovering, per-participant volume and missing-output muting.

The test inspects real WebRTC receive statistics and LiveKit participant tracks. It does not establish subjective audio quality, WAN latency, ten-person performance or hardware hot-unplug behavior. The selected speaker-loss simulation verifies application behavior after a device-change notification.

Reports/screenshots are ignored under artifacts/: voice-browser.json, voice-browser.png, auth-browser.json, messaging-browser.json and auth-desktop.json. The voice screenshot was visually reviewed. No passwords or media bearer tokens are written to reports.

## Authorization and lifecycle coverage

Database-backed voice tests exercise approved-only access, channel persistence and unique names, Origin/CSRF validation, one account across concurrent devices, idempotent reservation retry, explicit leave before switching, opaque client credentials, microphone-only grants, binary/JSON refresh-token sanitization, session binding, wrong-session leave protection, heartbeat expiry, session revocation, suspension and unauthorized gateway Origin.

Client regressions verify explicit device requirements, exclusion of Default/Communications aliases, cancellation while join is pending, missing-device behavior and deafen preserving the mute preference. Electron policy tests reject camera, screen, foreign-origin and embedded-frame requests. The real Electron harness additionally confirms camera getUserMedia is denied while an explicitly selected synthetic microphone reaches LiveKit.

Existing authentication/messaging tests remain intact: private DM and group history access, author-only edits/deletes, idempotency, reconnection, account state changes, cookie/CSRF protections and data preservation.

## Infrastructure and limits

The Docker Desktop media experiment initially failed ICE negotiation because loopback candidate collection inside the container produced duplicate mapped addresses. Disabling container loopback candidates while retaining explicit 127.0.0.1 host bindings resolved it. No LAN/public binding or public STUN service was introduced.

LiveKit's client is loaded only on voice connection. The production build currently emits a non-failing size advisory for its approximately 532 kB minified / 138 kB gzip lazy chunk. It does not add that SDK to the initial application bundle. Two existing deprecated Drizzle-tooling subdependencies remain; no production vulnerabilities were reported by the audit.

This is a single-process local voice MVP. Reservations are ephemeral; channels are persistent. Account checks run on each gateway handshake and in a one-second reconciliation sweep. Network/service failures may delay remote cleanup. No E2EE, private calls, ringing, push-to-talk, voice rename/archive UI, recording, streaming, signed installer, TURN/WAN setup or deployment is included. Edge/Electron on Windows 11 are verified; other browsers and physical devices require validation.

Use [README](../README.md) for exact startup, shutdown and test commands. Existing data, old migrations and Docker volumes are preserved. No push or deployment occurred.

## Development startup fix — 2026-10-25

The Windows development API watcher was observed remaining alive without opening port 3001, leaving the desktop command waiting indefinitely while Vite was ready. The launcher now uses Node's native watch mode with the existing tsx loader. A real subprocess regression runs that exact API command under concurrently, verifies HTTP health, touches an imported source file and verifies a successful restart.

The desktop readiness check now has a 30-second deadline, identifies unavailable services, and verifies the API response belongs to Tricord. Tests cover success, an unavailable API and an unrelated service on the API port. Existing normal/failing desktop-supervisor exit tests remain intact. The actual pnpm dev:desktop command was run: Vite and Fastify listened, readiness succeeded after starting PostgreSQL, and the real Tricord Electron window opened.

Four new startup regressions bring the suite to 104 tests (24 unit/regression and 80 database integration). The earlier production-build smoke tests did not cover this watch-mode startup path; the new regression closes that gap.

## Voice reliability and ten-client verification — 2026-10-25

The first capacity run reproduced an HTTP 429 while opening the eighth browser: static assets, channel polling and voice heartbeats consumed one shared IP budget. Static assets are now excluded from API counting, and voice endpoints have independent bounded 120/minute/IP quotas. Tests explicitly verify that API and heartbeat limits still reject excess requests.

Repeated runs also reproduced an intermittent publication race: all clients displayed Unmute as completed, but one server track stayed muted and the other clients received only eight streams. The SDK cannot signal a mute change before publication assigns the track SID. Tracks now publish muted, hold preference changes until publication completes, then apply the latest mute/deafen state.

Further regressions cover lease renewal during a retry without creating duplicate rooms, leaving during microphone acquisition/replacement, failed publication cleanup, obsolete microphone errors after rejoining or choosing another device, delayed output routing after leaving/rejoining, and device-enumeration rejection. Cleanup and error callbacks are fenced by room identity and join generation.

| Check                                  | Result                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| Unit/regression suite                  | 35 passing                                                           |
| Database integration suite             | 81 passing                                                           |
| Total Vitest tests                     | **116 passing**                                                      |
| Existing Edge authentication/messaging | 22 checks                                                            |
| Existing Electron                      | 23 checks across three launches                                      |
| Two-client voice                       | 17 checks with actual synthetic audio                                |
| Ten-client capacity/recovery           | 9 scenario checks; ten independent Edge processes                    |
| Static checks and builds               | Formatting, ESLint, TypeScript and production builds pass            |
| Infrastructure                         | Existing PostgreSQL healthy and LiveKit running; loopback ports only |

The capacity test uses approved disposable accounts, a temporary database, a unique LiveKit room prefix, synthetic microphones and production rate limits. It requires nine incoming audio streams, two active peer connections and one live microphone per connected client. A 65-second steady phase checks advancing audio counters, health responsiveness and reservation count. An eleventh account is rejected. All ten clients recover after simultaneous signaling loss and after an actual restart of the isolated API. A freed slot is reusable, and leaving closes all peer connections and captured microphones. HTTP 429 responses are forbidden throughout recovery as well as steady operation.

The harness removes only its own browser profiles, media rooms and database, and records cleanup failure as a failed run. It does not restart the shared LiveKit/PostgreSQL containers or change development accounts, applied migrations or volumes. Reports are ignored under artifacts/voice-load.json; failed runs also include diagnostics from the disposable clients.

These are local synthetic-audio results on one Windows 11 host, not a remote ten-person call or listening-quality certification. API memory includes the Node test harness and excludes browsers/Docker. Physical microphone/speaker quality, real USB/Bluetooth removal, long calls, WAN/TURN and hosting remain unverified. The existing approximately 532 kB lazy LiveKit chunk still produces a non-failing build-size advisory. No dependency, deployment, publication or push was added.

### Final recorded capacity run

| Measurement                                               | Observed result           |
| --------------------------------------------------------- | ------------------------- |
| Steady phase                                              | 65.3 seconds, ten clients |
| Maximum sampled API health response                       | 17.0 ms                   |
| Highest sampled event-loop p95 (20 ms monitor resolution) | 32.4 ms                   |
| Highest sampled Node API/test-process RSS                 | 230.1 MiB                 |
| Highest sampled inbound audio jitter                      | 2.0 ms                    |
| Cumulative received packets at end of steady phase        | 330794                    |
| Reported lost packets at end of steady phase              | 0                         |
| HTTP 429 responses, including recovery                    | 0                         |

All nine capacity/recovery checks passed, followed by successful test-resource cleanup. Expected HTTP 410 heartbeat responses after restarting the isolated API trigger fresh reservations; they are not failed authentication or throttling. These measurements describe this short local run and are not production service guarantees.

## Voice-test startup prerequisite fix — 2026-10-25

A user rerun failed with ECONNREFUSED at 127.0.0.1:5432 because Docker Desktop was stopped. The capacity command now performs a read-only PostgreSQL query and an authenticated LiveKit readiness call before building. Direct API invocation repeats the check before creating disposable fixtures. Missing services produce startup instructions without printing connection strings or raw driver errors.

The stopped-database path was reproduced with the actual root command: it exited before building and instructed the user to start Docker Desktop and run pnpm db:up. Docker Desktop and the existing Compose services were then started without replacing credentials or volumes. Five new regressions cover readiness, stopped PostgreSQL, stopped LiveKit, missing voice configuration and rejection of remote databases. They bring the suite to 121 tests (40 unit/regression and 81 database integration).

After startup, the exact root command pnpm test:voice:load passed its readiness checks, production build, all nine capacity/recovery scenarios and cleanup. All 40 unit/regression tests, lint, API TypeScript checking and repository formatting also passed. The existing LiveKit bundle-size advisory remains unrelated to service availability.

## GitHub and hosted-alpha preparation — 2026-10-25

All 127 Vitest tests pass (46 unit/regression, 81 database integration), along with formatting, lint, TypeScript and production builds. The existing Electron smoke still passes all 23 scenarios across three launches; the real two-browser voice smoke passes all 17 scenarios after adding hosted configuration.

A pinned multi-stage Linux server image was built and run as the non-root node user. Its isolated smoke verified migrations twice, web asset serving, PostgreSQL readiness, real registration/login with native password hashing, Secure/HttpOnly/SameSite cookies, pending-account restrictions, private Docker-network LiveKit room control, opaque hosted voice leases and an actual pg_dump/pg_restore round trip. The PostgreSQL fixture uses tmpfs; cleanup removes only test containers, their network and generated temporary files.

New configuration regressions enforce exact HTTPS desktop origins, preserve local/test origins, reject public LiveKit control hosts, require production voice credentials and allow server-supplied ICE/TURN configuration only for hosted leases. Temporary desktop-session cleanup now selects cookies only for its configured server.

GitHub Actions uses pinned official actions and read-only repository permissions. It runs the standard suites, production build, image build and backup/restore smoke without deploying. The initial history review covered all seven prior commits and 182 unique file blobs; configured secret values and sensitive-path/credential-pattern checks found no matches.

Cloud provisioning, DNS, trusted TLS termination, TURN/TLS, operational backup scheduling and cross-network voice testing still require a chosen server/domain and access. See hosting.md for the deployment boundary and remaining work. The existing LiveKit lazy-chunk advisory remains.

## Unread messages, mentions and desktop notifications — 2026-10-26

An additive Drizzle migration creates conversation_reads with one monotonic sequence cursor per account/conversation. The migration was applied to the existing development database and rerun successfully without removing any data or Docker volumes. Counts exclude own/deleted messages and enforce existing membership-history visibility; fetching history alone never advances read progress.

The UI adds unread and mention badges, an unread window-title count, complete case-insensitive @username matching and mention highlighting. Visible, focused reading at the latest messages advances the cursor. Reading older messages preserves scroll position and new unread messages until Jump to latest messages. Dialogs and mobile navigation prevent automatic acknowledgement. Socket delivery supplies authorized unread summaries for unselected conversations, and coalesced read acknowledgements use the same authenticated connection. Existing IP and socket request budgets remain unchanged. A regression exercises 100 read acknowledgements from ten accounts with production limits enabled, without HTTP conversation requests.

Notifications are opt-in per account/browser/device, cover private messages and mentions outside the focused conversation, and use generic previews without message text or participant names. Retries, edits and deletes do not create duplicate new-message alerts. The isolated Electron test verifies invalid IPC rejection, Windows development shortcut registration and a real native notification show event. Browser notification permission, generic body, click navigation and disabling are checked with only the OS notification adapter mocked. Notifications require the app/browser to remain open; no background push service is added. Multiple enabled devices may each alert.

Validation: 139 Vitest tests (51 unit/regression and 88 PostgreSQL integration), including cursor validation/monotonicity, cross-device synchronization, pre-join/absent membership privacy, suspension and recipient authorization. Formatting, ESLint, TypeScript and production builds pass. The expanded Edge smoke covers 30 authentication/messaging/unread/notification scenarios, including persistence after reload, controlled unfocused reading, notification navigation and reading history. Electron passes 26 scenarios across three launches; two-browser synthetic voice passes 17 scenarios. Visual inspection confirms badges and controls fit the existing desktop layout.

The production image and isolated backup/restore smoke are verified with the additive schema. Test accounts/databases and media resources remain disposable. No authentication, messaging or voice permissions are broadened; no dependencies, hosting deployment or GitHub push are introduced. The existing lazy LiveKit bundle-size advisory and legacy pnpm deploy warning remain non-failing. Physical microphone quality and remote ten-person voice remain outside this local verification.
