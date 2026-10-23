# Tricord

Milestone 1 is verified: shared React/Vite UI, sandboxed Electron, Fastify, Socket.IO, and local PostgreSQL with Drizzle migrations. Authentication, messaging persistence, roles, voice and streaming are not implemented. The interface labels sample conversations and profiles; sending is disabled.

## Windows prerequisites

Windows 11, Node.js 24 LTS, pnpm 11.25.0, Git, and running Docker Desktop using Linux containers. Open a fresh PowerShell after installing tools so PATH refreshes. If needed, install pnpm with `npm install --global pnpm@11.25.0`.

## First setup

```powershell
Set-Location F:\tricord
node --version
pnpm --version
docker version
docker compose version
pnpm install --frozen-lockfile
pnpm setup:desktop
pnpm db:setup
pnpm db:up
pnpm db:migrate
```

`db:setup` creates matching random credentials in ignored `infrastructure/.env` and `apps/api/.env`. It never prints credentials or overwrites existing files. If only one exists, reconcile the files manually. **Do not generate a new password for an existing database volume**: its initialized password remains unchanged. Environment examples document the supported settings. The web app uses localhost defaults; copy `apps/web/.env.example` only if you need to customize them.

`db:up` waits for the container health check. PostgreSQL is published only on **127.0.0.1:5432**. Data stays in the existing named volume `infrastructure_tricord_postgres`. This is local development infrastructure, not a hardened production deployment.

## Daily startup

```powershell
Set-Location F:\tricord
pnpm db:up
pnpm db:migrate
pnpm dev
```

Open **http://127.0.0.1:5173**. The UI displays API and real Socket.IO connection status. To run Electron instead, stop `pnpm dev` with Ctrl+C and run `pnpm dev:desktop`. This starts the same API/web services and opens Electron after they are ready.

From another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/ready
docker compose --env-file infrastructure/.env -f infrastructure/compose.yaml ps
```

`/health` is API liveness. `/ready` executes a real PostgreSQL query and returns 200 when connected, or 503 when configuration/connection is unavailable. Neither endpoint implements authentication; readiness does not substitute for applying migrations.

## Shutdown

Press **Ctrl+C** in the development terminal, then:

```powershell
pnpm db:down
```

This removes the container/network while retaining the database volume. Never use `down -v`, volume removal, or volume pruning to manage this project's database. Closing Electron also ends its development process group; there is no tray feature yet.

## Migrations and database tests

The initial migration creates `public.users`, `public.approval_status`, and Drizzle's `drizzle.__drizzle_migrations` journal. Pending approval is a schema default only; no registration or approval endpoints exist yet.

After editing the schema:

```powershell
pnpm db:generate
# Review the new SQL and metadata; do not rewrite an applied migration.
pnpm db:migrate
```

To reproduce database verification:

```powershell
pnpm db:up
pnpm db:migrate
pnpm test:db
pnpm db:verify-persistence
pnpm db:migrate
```

The seven database integration tests use real PostgreSQL: columns/defaults/constraints, insert/read/delete through Drizzle, uniqueness, invalid enum rejection, idempotent migrations, and Fastify readiness success/failure. They fail rather than silently skip if PostgreSQL or configuration is unavailable. Each generated row has a unique ID; cleanup deletes only those IDs. Tests do not truncate tables or delete existing records.

The separate persistence probe commits a uniquely identified row, **restarts the PostgreSQL container**, verifies the same row survives, then deletes only that fixture. Run it when interrupting your local development connections is acceptable. It never removes a volume. A failed restart/cleanup is reported as an error, not a pass.

## Full verification

```powershell
pnpm peers check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
```

The default suite has four API/socket tests and needs no database. The separate database suite has seven tests: **11 passing automated tests total**, plus the persistence probe. Use `pnpm format` to apply formatting.

To exercise production builds locally:

```powershell
pnpm build
# Terminal A
pnpm --filter @tricord/api start
# Terminal B
pnpm --filter @tricord/desktop start
# Or run the hidden desktop validation:
pnpm --filter @tricord/desktop smoke
```

The Electron report is written to ignored `artifacts/desktop.json`. Hidden-window screenshot capture may be unavailable; renderer isolation and connectivity are reported separately. Close the window to quit; Ctrl+C stops the API. No signed installer or update system exists yet.

## Repository

- `apps/web`: responsive React interface and actual connection status.
- `apps/desktop`: isolated Electron host and narrow read-only preload.
- `apps/api`: Fastify, Socket.IO, database client, schema, migrations and tests.
- `packages/shared`, `packages/ui`: shared contracts and UI primitives.
- `infrastructure`: localhost-only Compose configuration.
- `scripts`: non-overwriting local environment setup.
- `docs`: requirements, decisions and verification evidence.
- `experiments`: preserved historical prototypes, excluded from active builds/checks.

The lockfile pins resolved dependencies. TypeScript 6 is selected for compatibility with typescript-eslint; no new dependencies were needed for database verification. See [decisions](docs/decisions.md) and [verification](docs/verification.md). No cloud resources or public repository were created.

Next milestone: secure registration, pending approval, revocable sessions, approved-member approval/channel permissions, and owner-only removal/security controls. Add authorization tests before storing private conversations.
