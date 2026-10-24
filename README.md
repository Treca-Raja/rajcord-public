# Tricord

Milestone 2B adds persistent, real-time shared text channels, private one-to-one DMs and invitation-based group DMs to the existing authenticated React/Electron application. Browser and desktop use the same messaging UI. PostgreSQL is the source of truth; authentication and account approvals from Milestone 2A are preserved.

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
pnpm db:migrate
pnpm dev
```

Open **http://127.0.0.1:5173**. Sign in as the owner. Friends can create accounts and sign in to see their pending status. Open **Settings → People & approvals** to approve or reject registrations. Every approved member has those approval controls. Owner-only suspend, restore, remove and ownership-transfer controls appear for eligible accounts. Approvals reach connected users automatically.

To run the desktop app, stop `pnpm dev` with Ctrl+C, then:

```powershell
pnpm dev:desktop
```

The same screens run in the sandboxed Electron renderer. A normal desktop exit stops its development helpers and returns success; actual app/helper failures still fail. Minimize retains the session. Closing the window fully quits; there is no tray mode. Temporary sessions are revoked on an orderly online quit and their local cookie is removed. Remembered sessions survive restart for up to 30 days. Settings includes display-name changes, password changes, device revocation and logout.

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
pnpm db:down
```

This preserves the database volume. Never use `down -v`, volume removal or pruning for this project.

## Messaging behavior

Approved members can create, rename, archive and reopen shared channels. Use the sidebar plus buttons to open a DM or create a group; clicking a community member opens the same persistent DM for that pair. Groups start with the creator as manager. Any current member can invite approved users, but invitees must accept in their inbox. Only the manager can remove members, rename the group or transfer management. A manager must transfer before leaving a nonempty group.

New group members see messages sent after acceptance. Leaving or removal immediately denies group access. Rejoining restores messages from earlier membership periods plus new messages, while messages sent during the absence remain hidden. These rules apply to history pages, direct message IDs and realtime synchronization.

Messages are plain text, limited to 4,000 characters. Enter sends; Shift+Enter adds a newline. Only the author can edit/delete, including in archived channels; administrators have no override. Deletion clears content and retains a stable tombstone for synchronization. History otherwise has no automatic expiry. “Load older messages” uses server sequence pagination.

The composer keeps its draft on connection/send failure and retries with the same idempotency ID. Reconnection synchronizes missed sends, edits and deletions. There is no durable offline queue; reloading or switching conversations can discard an unsent draft. No uploads, search, unread counters, blocking UI or media are included.

## Verification

With Docker Desktop running:

```powershell
Set-Location F:\tricord
pnpm db:up
pnpm db:migrate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
pnpm --filter @tricord/api test:browser
pnpm --filter @tricord/api test:desktop
pnpm db:verify-persistence
pnpm db:migrate
pnpm peers check
pnpm audit --prod
```

There are **77 passing Vitest tests**: 4 foundation, 7 database, 29 authentication/security, 29 messaging and 8 client/pool/development-lifecycle regressions. The browser and Electron commands are additional integration scenarios, separate from that count.

- `test:db` checks the existing development schema with unique disposable rows. Authentication and messaging tests create uniquely named temporary databases, migrate it, then drop **only the database created by that test run**. Your development database, owner, migration history and volume are preserved. The local development database role must have CREATEDB permission for these tests.
- The browser smoke runs real headless Microsoft Edge with an isolated temporary profile and disposable database. It checks registration, pending restrictions, approval, cookies, administrator UI, reload persistence and live suspension. It also verifies channel messaging across independent sessions, plaintext rendering, editing/deletion, DMs, group invitation acceptance and history privacy: 11 authentication plus 11 messaging checks. It captures desktop/mobile screenshots. Edge's default Windows path is used; set `TRICORD_BROWSER_PATH` to another installed Chromium executable if needed.
- The Electron smoke uses three real launches with an isolated temporary profile. It verifies registration, live approval, account settings, logout, minimization, temporary-session cleanup and remembered-session restoration, plus renderer isolation and absence of localStorage tokens. Sending, receiving from an independent account and restored message history bring the total to 17 checks.
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

These commands test production **build artifacts on local HTTP**. They do not deploy production infrastructure. Future HTTPS deployment must use `NODE_ENV=production` and an explicit HTTPS-only `WEB_ORIGINS` list; this enables Secure cookies and rejects HTTP origin configuration. Reverse proxy, TLS, distributed rate limits and remote desktop-server configuration are not configured in this milestone.

## Database migrations

The original `0000_mute_darkstar.sql` and `0001_boring_guardian.sql` are unchanged by Milestone 2B. The additive `0001_boring_guardian.sql` extends approval status and adds credentials, sessions, a singleton owner designation, approval history and case-insensitive username uniqueness.

```powershell
pnpm db:generate
# Review new SQL and metadata. Never rewrite an applied migration.
pnpm db:migrate
```

Additive `0002_overrated_puck.sql` creates conversations, membership periods, invitations and messages, including ordering, idempotency and DM-pair constraints. It seeds the shared `general` channel. There are now nine public tables. Existing users remain intact. Rows from the foundation without credentials cannot sign in. Existing usernames that differ only by case would block the new unique index safely; reconcile such a conflict deliberately rather than deleting accounts or resetting migrations.

## Security and current limits

Passwords use Argon2id. Random session tokens are stored only as hashes in PostgreSQL and HttpOnly SameSite=Strict cookies on clients. CSRF tokens stay in renderer memory. Mutations require an exact trusted Origin; authenticated mutations also require session-bound CSRF. Sessions have absolute 12-hour or 30-day expiry. Logout, password changes, device revocation, suspension and removal invalidate server sessions. Status and owner permissions are checked in the backend, including each protected socket event.

Removed accounts become tombstones, preserving audit and identity history. They cannot sign in. Administration grants no application access to private conversations and no permission to edit/delete another author’s messages. Messages are not end-to-end encrypted: the database operator can read stored content. Security configuration remains local operator configuration; there is no public settings editor or endpoint granting members control over it.

Crash/offline quits cannot guarantee immediate server revocation. Electron discards temporary local cookies at startup, and remaining server sessions expire within 12 hours or can be revoked from another device. Browser session restoration may preserve session cookies according to browser settings. No password recovery, MFA, email verification, TLS deployment, signed installer or multi-process socket adapter is implemented. HTTP/socket event limits are in-process; the message-send quota is persisted in PostgreSQL. This implementation targets a single API process and up to ten friends. Login errors are generic; registration necessarily reveals whether a username can be used.

See [security decisions](docs/decisions.md) and [verification evidence](docs/verification.md). Recommended Milestone 2C: an authenticated voice-channel MVP with join/leave, microphone selection and mute controls, preceded by a small media architecture experiment. Leave video/streaming and cloud deployment for later.
