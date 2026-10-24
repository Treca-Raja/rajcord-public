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
