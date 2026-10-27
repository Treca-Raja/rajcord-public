# Tricord

Active public repository: [Treca-Raja/tricord-public](https://github.com/Treca-Raja/tricord-public).

Milestone 2C adds local community voice channels to the authenticated React/Electron application, alongside persistent shared text channels, private DMs and group DMs. Browser and desktop use the same messaging UI. PostgreSQL is the source of truth; authentication and account approvals from Milestone 2A are preserved.

## Working with coding agents

Start with [AGENTS.md](AGENTS.md) for project rules, [MEMORY.md](MEMORY.md) for dated context and [SKILLS.md](SKILLS.md) for reusable verification, database, voice and hosting workflows.

## Windows prerequisites

Windows 11, Node.js 24 LTS, pnpm 11.25.0, Git and Docker Desktop running Linux containers. Keep PostgreSQL and the API on loopback.

On this workstation, if PowerShell cannot find the already-installed tools, add their locations for the current terminal:

```powershell
$env:Path += ";$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback"
$env:Path += ";$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
Set-Location F:\tricord
```

On another machine, install pnpm normally with `npm install --global pnpm@11.25.0` and reopen PowerShell after installing Docker Desktop.

## Setup and first owner

```powershell
Set-Location F:\tricord
pnpm install --frozen-lockfile
pnpm setup:desktop
pnpm db:setup
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm owner:bootstrap
```

The last command runs a **local interactive CLI**. Enter a new, unused username, a display name, and a password of 12–128 characters. The password is hidden and is never passed as a command-line argument or printed. Do not put a password in a shell command or committed file. Bootstrap creates one approved owner atomically. Repeating it stops without changing anything. An existing public registration is never automatically promoted; choose an unused owner username. No owner was created in your development database by the automated tests.

`db:setup` creates matching random database credentials in ignored `infrastructure/.env` and `apps/api/.env` only when both are absent. It preserves existing files. Never regenerate the password for an initialized volume. For an older checkout, ensure `apps/api/.env` contains this origin list while preserving its existing DATABASE_URL:

```dotenv
HOST=127.0.0.1
PORT=3001
WEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001
```

The browser uses same-origin requests. Vite proxies `/api` and `/socket.io` to Fastify. No browser credentials or API URL belong in a Vite environment file.

## Daily startup

```powershell
Set-Location F:\tricord
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm dev
```

Open **http://127.0.0.1:5173**. Sign in as the owner. Friends can create accounts and sign in to see their pending status. Open **Settings → People & approvals** to approve or reject registrations. Every approved member has those approval controls. Owner-only suspend, restore, remove and ownership-transfer controls appear for eligible accounts. Approvals reach connected users automatically.

To run the desktop app, stop `pnpm dev` with Ctrl+C, then:

```powershell
pnpm dev:desktop
```

The API uses Node’s watch mode with the existing tsx TypeScript loader. Desktop startup waits up to 30 seconds for Vite and a valid Tricord API health response, then opens Electron. If startup fails, it names the unavailable service and stops the helpers instead of waiting forever.

The same screens run in the sandboxed Electron renderer. A normal development desktop exit stops its helpers and returns success; actual app/helper failures still fail. Minimize retains the session. Closing a development window quits. Installed Rajcord closes to the tray; **Quit Rajcord** or Ctrl+Q exits and disconnects voice. Temporary sessions are revoked on an orderly online quit and their local cookie is removed. Remembered sessions survive restart for up to 30 days. Settings includes display-name changes, password changes, device revocation and logout.

## Rajcord Windows installer

```powershell
pnpm desktop:package
pnpm desktop:audit
```

The Windows x64 NSIS installer is written to `artifacts/desktop/Rajcord-Setup-0.1.0-x64.exe` (version from `apps/desktop/package.json`). Installed clients always connect to `https://rajcord.com`. The default unsigned build supports manual installation; verified automatic updates require a signed build. See the [desktop distribution runbook](docs/desktop-distribution.md) for signing, versioning, guarded GitHub draft releases, install testing and manual voice/update acceptance gates. No release is published by a local build.

From another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/ready
docker compose --env-file infrastructure/.env -f infrastructure/compose.yaml ps
```

Readiness checks a real database connection; it does not apply migrations. PostgreSQL is bound only to **127.0.0.1:5432**, using the existing named volume `infrastructure_tricord_postgres`.

## Shutdown

Close Electron if it is running, then press **Ctrl+C** in the development terminal. Stop PostgreSQL with:

```powershell
Set-Location F:\tricord
pnpm voice:down
pnpm db:down
```

This preserves the database volume. Never use `down -v`, volume removal or pruning for this project.

## Messaging behavior

Approved members can create, rename, archive and reopen shared channels. Use the sidebar plus buttons to open a DM or create a group; clicking a community member opens the same persistent DM for that pair. Groups start with the creator as manager. Any current member can invite approved users, but invitees must accept in their inbox. Only the manager can remove members, rename the group or transfer management. A manager must transfer before leaving a nonempty group.

New group members see messages sent after acceptance. Leaving or removal immediately denies group access. Rejoining restores messages from earlier membership periods plus new messages, while messages sent during the absence remain hidden. These rules apply to history pages, direct message IDs and realtime synchronization.

Messages are plain text, limited to 4,000 characters. Enter sends; Shift+Enter adds a newline. Only the author can edit/delete, including in archived channels; administrators have no override. Deletion clears content and retains a stable tombstone for synchronization. History otherwise has no automatic expiry. “Load older messages” uses server sequence pagination.

The composer keeps its draft on connection/send failure and retries with the same idempotency ID. Reconnection synchronizes missed sends, edits and deletions. There is no durable offline queue; reloading or switching conversations can discard an unsent draft. No uploads, search or blocking UI are included. Community voice is described below.

## Unread messages, mentions and notifications

Unread counts and @mention badges appear beside channels, DMs and groups, and the window title shows the total unread count. Read progress is saved per account in PostgreSQL and shared across devices. Authenticated sockets carry unread summaries and read acknowledgements without extra HTTP inbox polling; read acknowledgements are coalesced while reading continuously, and existing request limits remain unchanged. Your own messages and deleted messages do not count as unread. Group counts follow the same membership-history rules as message access. Existing history starts unread until you open it.

Opening a conversation at its latest messages marks earlier accessible messages read only while the window is focused and visible, with no dialog or mobile navigation covering it. Scrolling up preserves unread status for new arrivals and does not jump you away from history; use **Jump to latest messages** to catch up. Simply fetching history never marks it read. These are private account read cursors, not read receipts shown to other members.

Write **@username** to mention someone (case-insensitive, complete usernames). Usernames appear in the people list. Matching messages are highlighted for the mentioned user. Repeating a mention in one message counts once; edits and deletions update unread mention counts without generating a fresh alert. There are no @everyone/@here broadcasts or mention autocomplete yet.

Choose **Enable notifications** in the sidebar on each browser/device. Alerts cover private messages and mentions away from the focused conversation. Notification previews contain no message text or participant names; clicking opens the conversation. Turn them off with **Disable notifications**. Only this per-account notification preference is stored in localStorage; authentication remains in HttpOnly cookies.

On Windows, enabling alerts registers a **Tricord development** Start Menu shortcut for Electron notifications. The app reports setup or native delivery failure instead of silently claiming success. Windows notification settings and Do Not Disturb can still suppress visible banners. The development shortcut is for notification registration; start development services with the commands above.

Notifications require Tricord to stay open (minimized is fine). There is no push delivery after closing the browser/app and no replay of old alerts on reconnect; persisted unread counts catch up instead. Multiple open browsers/devices may each alert if enabled. Public browser hosting requires trusted HTTPS.

## Verification

With Docker Desktop running (the database suite and browser/Electron smoke also require the local voice service):

```powershell
Set-Location F:\tricord
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
pnpm --filter @tricord/api test:browser
pnpm --filter @tricord/api test:desktop
pnpm --filter @tricord/api test:voice
pnpm --filter @tricord/api test:voice:load
pnpm db:verify-persistence
pnpm db:migrate
pnpm peers check
pnpm audit --prod
```

There are **139 passing Vitest tests**: 51 unit/regression tests and 88 database integration tests, including unread persistence, mention boundaries, membership privacy, read-cursor validation and notification delivery authorization. The browser and Electron commands are additional integration scenarios, separate from that count.

- `test:db` checks the existing development schema with unique disposable rows. Authentication and messaging tests create uniquely named temporary databases, migrate it, then drop **only the database created by that test run**. Your development database, owner, migration history and volume are preserved. The local development database role must have CREATEDB permission for these tests.
- The browser smoke runs real headless Microsoft Edge with an isolated temporary profile and disposable database. It checks registration, pending restrictions, approval, cookies, administrator UI, reload persistence and live suspension. It also verifies channel messaging across independent sessions, plaintext rendering, editing/deletion, DMs, group invitation acceptance and history privacy: 11 authentication plus 19 messaging/unread/notification checks (30 total); OS notifications are mocked for deterministic permission, preview and click tests. It captures desktop/mobile screenshots. Edge's default Windows path is used; set `TRICORD_BROWSER_PATH` to another installed Chromium executable if needed.
- The Electron smoke uses three real launches with an isolated temporary profile. It verifies registration, live approval, account settings, logout, minimization, temporary-session cleanup and remembered-session restoration, plus renderer isolation and absence of localStorage tokens. Sending, receiving from an independent account and restored message history plus voice device selection, microphone publication, camera denial, mute/deafen and leave bring the total to 26 checks, including notification IPC validation, Windows registration and a real native notification show event.
- Browser/Electron smoke servers bind to **127.0.0.1:3003 / :3002**, respectively. Reports/screenshots go to ignored `artifacts/`. Their temporary profiles are separate from your real browser and desktop profile.
- `db:verify-persistence` restarts the existing PostgreSQL container, uses its own disposable database to verify accounts, sessions, audit records, invitations, channels, DMs, group history boundaries, idempotent retries and message persistence. Existing Fastify/pg pools must recover. It then drops only its own test database and verifies the development migration journal is unchanged. Run it when interrupting development connections is acceptable.
- `pnpm test:browser` and `pnpm test:desktop` are convenience commands that build first. Tests fail when required infrastructure is missing; they do not silently skip.

## Run the built applications locally

```powershell
pnpm build
# Terminal A
pnpm --filter @tricord/api start
# Terminal B
pnpm --filter @tricord/desktop start
```

The backend serves built web assets at **http://127.0.0.1:3001**. You can also open that address in a browser. Built Electron loads this same origin instead of file URLs. The API must be running.

These commands test production **build artifacts on local HTTP**. They do not deploy production infrastructure. Future HTTPS deployment must use `NODE_ENV=production` and an explicit HTTPS-only `WEB_ORIGINS` list; this enables Secure cookies and rejects HTTP origin configuration. Reverse proxy, TLS and distributed rate limits are not deployed. An exact HTTPS desktop-server URL can now be configured; see the hosting preparation guide.

## Database migrations

The original `0000_mute_darkstar.sql` and `0001_boring_guardian.sql` are unchanged by Milestone 2B. The additive `0001_boring_guardian.sql` extends approval status and adds credentials, sessions, a singleton owner designation, approval history and case-insensitive username uniqueness.

```powershell
pnpm db:generate
# Review new SQL and metadata. Never rewrite an applied migration.
pnpm db:migrate
```

Additive `0002_overrated_puck.sql` creates conversations, membership periods, invitations and messages, including ordering, idempotency and DM-pair constraints. It seeds the shared `general` channel. Milestone 2C migration 0003 adds persistent voice_channels and seeds The lounge; there are now ten public tables. Existing users remain intact. Rows from the foundation without credentials cannot sign in. Existing usernames that differ only by case would block the new unique index safely; reconcile such a conflict deliberately rather than deleting accounts or resetting migrations.

## Security and current limits

Passwords use Argon2id. Random session tokens are stored only as hashes in PostgreSQL and HttpOnly SameSite=Strict cookies on clients. CSRF tokens stay in renderer memory. Mutations require an exact trusted Origin; authenticated mutations also require session-bound CSRF. Sessions have absolute 12-hour or 30-day expiry. Logout, password changes, device revocation, suspension and removal invalidate server sessions. Status and owner permissions are checked in the backend, including each protected socket event.

Removed accounts become tombstones, preserving audit and identity history. They cannot sign in. Administration grants no application access to private conversations and no permission to edit/delete another author’s messages. Messages are not end-to-end encrypted: the database operator can read stored content. Security configuration remains local operator configuration; there is no public settings editor or endpoint granting members control over it.

Crash/offline quits cannot guarantee immediate server revocation. Electron discards temporary local cookies at startup, and remaining server sessions expire within 12 hours or can be revoked from another device. Browser session restoration may preserve session cookies according to browser settings. No password recovery, MFA, email verification, TLS deployment, signed installer or multi-process socket adapter is implemented. HTTP/socket event limits are in-process; the message-send quota is persisted in PostgreSQL. This implementation targets a single API process and up to ten friends. Login errors are generic; registration necessarily reveals whether a username can be used.

See [security decisions](docs/decisions.md) and [verification evidence](docs/verification.md). Recommended next: validate real headsets and hardware disconnection behavior, then add private/group calling and blocking rules. Leave video/streaming and cloud deployment for later.

## Local voice channels (Milestone 2C)

LiveKit 1.13.10 runs as a separate local Docker service. Approved users can create persistent voice channels and join one channel per account across devices. Each room is capped at ten participants. Private calls, push-to-talk, streaming, tray behavior and hosting are later milestones.

First-time voice setup (preserves all existing database files and data):

```powershell
Set-Location F:\tricord
pnpm voice:setup
pnpm voice:up
pnpm db:up
pnpm db:migrate
pnpm dev:desktop
```

The setup command creates random keys in ignored infrastructure/.env.voice and preserves an existing file. The API reads this file locally. LiveKit control/signaling (7880), media TCP (7881) and media UDP (7882) are bound only to 127.0.0.1. No public STUN/TURN service, paid service or cloud deployment is used. Docker Compose keeps the voice service separate from the PostgreSQL volume.

In the sidebar, open **Audio controls → Find audio devices**, allow microphone permission, select a concrete microphone and speakers, then choose a channel. Joining starts muted. Use the microphone, deafen and leave buttons; participant sliders control playback volume independently. Deafen also suppresses your microphone and restores your prior mute preference when disabled. “Enable audio playback” handles browser autoplay restrictions.

Device discovery briefly opens and immediately stops a microphone to reveal device labels. It does not transmit audio. Calls use exact device IDs, excluding the Windows Default/Communications aliases. A missing microphone stops transmission; missing speakers mute playback. Choose a replacement explicitly. Browser/OS device-disconnection notifications determine when this is detected. This milestone requires output-selection support, verified in Edge and Electron on Windows 11; other browsers are not yet certified.

Network reconnection preserves in-memory mute/deafen, devices and participant volumes. Voice reservations have a 45-second heartbeat lifetime; still-authenticated clients can obtain a fresh reservation after expiry or an API restart. Manual leave, logout, suspension and full quit stop client recovery. Fresh launches never join automatically. An offline quit can leave a server reservation for up to 45 seconds.

Voice uses the existing session cookie and CSRF boundary. The API issues an opaque reservation credential, not a LiveKit bearer token. Its same-origin signaling gateway reauthorizes each handshake and replaces refreshed LiveKit tokens before forwarding them. Only microphone publication is granted. Removal is enforced at the media server; a one-second sweep also handles expiration and external account changes. This is a single-API-process development design. LiveKit terminates media encryption; it is not end-to-end encryption.

Run the real two-browser synthetic-audio test after building:

```powershell
pnpm build
pnpm --filter @tricord/api test:voice
```

This test covers actual received audio, independent sessions, mute/deafen, selected output, volume, disconnect/reconnect, API restart, simulated device loss and revocation. Electron tests also publish a synthetic microphone track and deny camera capture. Physical microphones, unplugging real USB/Bluetooth hardware, listening quality and WAN/TURN behavior still need manual validation.

## Ten-client voice reliability test

Start Docker Desktop and the existing services first:

```powershell
Set-Location F:\tricord
docker desktop start
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm test:voice:load
```

This command checks PostgreSQL and authenticated LiveKit readiness before building, then launches ten isolated headless Edge processes with synthetic microphones. If a service is stopped, it exits with startup instructions before spending time on the build. The direct API test command also checks readiness. It runs a 65-second steady audio test, rejects an eleventh account, drops all signaling connections, restarts only its disposable Fastify instance, verifies recovery, frees and reuses a slot, then checks that leaving closes peer connections and microphone tracks. Each connected client must receive nine audio streams and retain exactly two active peer connections (publisher/subscriber). Audio byte counts must advance at every sample. Production HTTP rate limits stay enabled, with no HTTP 429 responses allowed.

The test binds to **127.0.0.1:3005** and uses a temporary database and unique LiveKit room prefix. It cleans up its own browser profiles and resources; development accounts, database volumes, the main API and other voice rooms are preserved. Allow several minutes and enough memory for ten browser processes. It never opens physical microphones. The ignored report **artifacts/voice-load.json** includes checks, per-client WebRTC counters, API health latency, event-loop delay and API/test-process memory. That memory measurement excludes Docker and browser processes.

Static files no longer consume the API rate budget. Each voice endpoint has its own 120-request/minute/IP budget, so ten clients sharing one address can heartbeat and poll without blocking each other. Authentication limits, approval checks, CSRF, origin checks and room capacity remain enforced.

This is ten real software clients on one Windows host using loopback networking, not ten people on different networks. Physical headset quality, Bluetooth/USB changes, long calls and remote networking remain unverified. See [verification evidence](docs/verification.md) for measured results.

## GitHub and hosted alpha preparation

See [hosting preparation](docs/hosting.md) for the tested server image, automated GitHub checks, HTTPS desktop configuration and remaining deployment steps. Local development commands remain unchanged.

The [production deployment runbook](docs/deployment.md) describes the prepared CI/CD pipeline, production approval, certificate renewal and encrypted off-server backup/restore jobs. CI uses disposable test environments; a permanent staging server is not required. Delivery stays disabled until the production host and GitHub environment are configured and `HOSTING_ENABLED=true` is set. Verify the hosted stack locally with `pnpm test:hosting` after `pnpm server:build`. Generate server-only configuration with `pnpm hosting:init production PUBLIC_IPV4 ABSOLUTE_DIRECTORY rajcord.com turn.rajcord.com`; omitting the last two arguments retains IP-only TLS. Domain DNS, public certificate issuance and renewal rehearsal have been verified; deployed service reloads and WAN voice still need live validation.

For the Linux VPS, the reviewed host helpers under `scripts/hosting/` prepare Docker/firewall rules, key-only SSH and a separate CI deployment account. `initialize-runtime.sh` generates server-only configuration using the pinned Node container, so host Node installation is optional. The existing VPS now has these foundations and issued public certificates; the encrypted R2 repository is initialized and its storage round trip is verified. The application, live database backup/recovery and active release maintenance jobs remain pending. See the dated verification record before treating a prepared component as live.

For first-release image preparation, `gh workflow run verify.yml --ref main -f publish_only=true` tests and publishes the current-main image without entering production policy/approval/deployment jobs. Keep `HOSTING_ENABLED=false` while configuring GHCR image access. The normal workflow's publication and approval-gated deployment behavior is unchanged when this manual input is false.
