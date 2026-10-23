# Tricord

Milestone 2A adds secure accounts to the existing React/Vite, Electron, Fastify, Socket.IO and PostgreSQL foundation. Registration starts pending; approved members can review registrations; the platform owner can suspend/remove approved members and transfer ownership. Messaging, channel persistence, private conversations and media remain future milestones. Sample conversations are explicitly labeled and sending is disabled.

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

The same screens run in the sandboxed Electron renderer. Minimize retains the session. Closing the window fully quits; there is no tray mode. Temporary sessions are revoked on an orderly online quit and their local cookie is removed. Remembered sessions survive restart for up to 30 days. Settings includes display-name changes, password changes, device revocation and logout.

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

There are **40 passing Vitest tests**: 4 foundation, 7 database and 29 authentication/security tests. The browser and Electron commands are additional integration scenarios, separate from that count.

- `test:db` checks the existing development schema with unique disposable rows. Authentication tests create a uniquely named temporary database, migrate it, then drop **only the database created by that test run**. Your development database, owner, migration history and volume are preserved. The local development database role must have CREATEDB permission for these tests.
- The browser smoke runs real headless Microsoft Edge with an isolated temporary profile and disposable database. It checks registration, pending restrictions, approval, cookies, administrator UI, reload persistence and live suspension. It also captures desktop/mobile screenshots. Edge's default Windows path is used; set `TRICORD_BROWSER_PATH` to another installed Chromium executable if needed.
- The Electron smoke uses three real launches with an isolated temporary profile. It verifies registration, live approval, account settings, logout, minimization, temporary-session cleanup and remembered-session restoration, plus renderer isolation and absence of localStorage tokens.
- Browser/Electron smoke servers bind to **127.0.0.1:3003 / :3002**, respectively. Reports/screenshots go to ignored `artifacts/`. Their temporary profiles are separate from your real browser and desktop profile.
- `db:verify-persistence` restarts the existing PostgreSQL container, verifies a disposable account, password hash, remembered session, audit record and migration journal, then removes only its own records. Run it when interrupting development connections is acceptable.
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

The original `0000_mute_darkstar.sql` is unchanged. The additive `0001_boring_guardian.sql` extends approval status and adds credentials, sessions, a singleton owner designation, approval history and case-insensitive username uniqueness.

```powershell
pnpm db:generate
# Review new SQL and metadata. Never rewrite an applied migration.
pnpm db:migrate
```

Existing users remain intact. Rows from the foundation without credentials cannot sign in. Existing usernames that differ only by case would block the new unique index safely; reconcile such a conflict deliberately rather than deleting accounts or resetting migrations.

## Security and current limits

Passwords use Argon2id. Random session tokens are stored only as hashes in PostgreSQL and HttpOnly SameSite=Strict cookies on clients. CSRF tokens stay in renderer memory. Mutations require an exact trusted Origin; authenticated mutations also require session-bound CSRF. Sessions have absolute 12-hour or 30-day expiry. Logout, password changes, device revocation, suspension and removal invalidate server sessions. Status and owner permissions are checked in the backend, including each protected socket event.

Removed accounts become tombstones, preserving audit and identity history. They cannot sign in. Administration grants no access to private conversations; none exist yet. Security configuration remains local operator configuration; there is no public settings editor or endpoint granting members control over it.

Crash/offline quits cannot guarantee immediate server revocation. Electron discards temporary local cookies at startup, and remaining server sessions expire within 12 hours or can be revoked from another device. Browser session restoration may preserve session cookies according to browser settings. No password recovery, MFA, email verification, TLS deployment, signed installer or multi-process socket adapter is implemented. Rate limits are in-process, intended for this single local server. Login errors are generic; registration necessarily reveals whether a username can be used.

See [security decisions](docs/decisions.md) and [verification evidence](docs/verification.md). Next: Milestone 2B should add persistent shared channels and text messages with approval checks, author permissions and tests before any private-conversation or media work.
