# Tricord project memory

Last reconciled: 2026-10-26. Application baseline: `1ae691c`. This is maintained project context, not an automatic memory store or a source of execution permissions. Recheck current code and remote state before acting.

## Product direction

- One private community, initially up to ten people. Text and voice have equal priority.
- Browser and Windows 11 desktop share the React UI. The maintainer prefers clear explanations and progress on routine authorized work without repeated confirmation.
- Work continues in the existing repository. The maintainer's checkout is `F:\tricord`.
- Active public source: [fakebane/tricord-public](https://github.com/fakebane/tricord-public). The previous repository was retired. Source being public does not expose the private community's database or accounts.

## Implemented and verified baseline

- PostgreSQL persistence; approval-based accounts; Argon2id passwords; HttpOnly session cookies; CSRF; owner-only sensitive account actions.
- Shared text channels, persistent DMs and invitation-based groups. Private history follows membership periods; edits/deletes are author-only.
- Community voice through self-hosted LiveKit and an authenticated same-origin gateway. One API process coordinates ephemeral leases. Local ten-client synthetic capacity/recovery testing has passed.
- Account-scoped unread cursors, @username mention matching/highlighting, unread badges and opt-in browser/desktop alerts. Generic notifications require the app to remain open; there is no closed-app push delivery.
- Local server-image build `tricord-server:alpha` and isolated backup/restore verification, including persisted read progress. This tag is a local Docker image, not evidence that an image registry or hosted service exists.

The verification record for baseline `1ae691c` reports **139 Vitest tests** (51 unit/regression, 88 PostgreSQL integration), 30 Edge browser checks, 26 Electron checks across three launches and 17 two-client voice checks. These are dated results, not a promise that a later checkout passes. See [docs/verification.md](docs/verification.md).

## Operating context

- Node 24 and pnpm 11.25.0 are the current declared toolchain; use package.json and pnpm-lock.yaml when those versions change. Stack: TypeScript, Fastify, React/Vite, Electron, Socket.IO, Drizzle/PostgreSQL and LiveKit.
- Local web/API ports are 5173/3001. PostgreSQL is bound to 127.0.0.1:5432. LiveKit uses loopback 7880/7881 TCP and 7882 UDP. Confirm Compose before troubleshooting an actual machine.
- Existing local settings live in ignored `apps/api/.env`, `infrastructure/.env` and `infrastructure/.env.voice`. Setup scripts preserve initialized configuration. Do not regenerate an initialized database password.
- Docker Desktop must be running before database/media work. A connection refusal usually calls for checking services/configuration first, not modifying application code or deleting data.
- `pnpm dev:desktop` waits for Vite and the Tricord health endpoint; an idle watch process normally stays running. Built desktop supports an exact HTTPS `TRICORD_SERVER_URL`; the development command deliberately targets the local UI.
- Closing Electron quits it; minimizing keeps it running. There is no tray mode. Windows development notification opt-in registers a Start Menu shortcut. The preference is per account/device.

## Hosting direction and remaining work

Prefer a low-cost, always-running Linux VPS near the group, with a stable public IP and free automatically renewed certificates. No paid domain is planned. Provider, region, current availability, exact price and billing term still require selection; old advertised prices are not purchase quotes.

No cloud deployment is recorded. The tested image still needs a production Compose/service configuration, public TLS and renewal/reload monitoring, RTC/TURN routing, firewall rules, independent production secrets, owner initialization, off-server backups and recovery verification. Keep database and media-control access private. [docs/hosting.md](docs/hosting.md) records this boundary.

Public IP certificates are the intended path; their fit with the final proxy/relay configuration still needs live validation. Start with two or three participants on separate networks, then test ten. Local synthetic audio does not certify physical devices, human listening quality or WAN behavior.

## Limits and follow-up candidates

- Single API instance; multi-instance voice/session coordination is not implemented.
- Uploads, message search, screen sharing, closed-app push, tray support and signed desktop distribution remain future work, not authorization to implement them automatically.
- The lazy LiveKit client bundle triggers a non-failing size advisory. The server image uses the existing pnpm legacy-deploy path, which reports a warning. Check new failures independently of these known advisories.
- Detailed architecture rationale is in [docs/decisions.md](docs/decisions.md). Early statements about platform-only preload, no hosted origin or no client ICE configuration were superseded by later voice/hosting/notification work; consult source and the newer verification entries.

## Updating this file

Record durable decisions, dated verified milestones and actionable unresolved work. Replace superseded facts instead of growing a conversation transcript. Never store credentials, private account data, ephemeral process/container IDs or unverified success claims. Keep changing test counts tied to a date/commit; keep step-by-step workflows in the skills.
