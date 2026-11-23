# Rajcord

Private, self-hosted text/voice app; public pnpm monorepo. No fixed production room headcount cap; measured media capacity depends on the host and workload.

Repository/guidance names use Rajcord. Existing `@tricord/*`, `TRICORD_*`, database/volume/cookie names and server paths remain compatibility identifiers; do not globally replace them. See [naming scope](README.md#naming-and-compatibility).

## Work efficiently

- Confirm the checkout and worktree before editing; preserve unrelated and staged work. Stay in this repository unless another project is explicitly in scope. Never import private work-project content.
- Start with the request and affected source/tests. Reuse current context; do not reread unchanged instructions or expand every link. Batch independent reads and avoid repeated builds/checks without a relevant change or unresolved failure.
- Load skills only for the current task/phase. [SKILLS.md](SKILLS.md) is a discovery fallback, not a required preload. Use [MEMORY.md](MEMORY.md) only for relevant history, hosting state or decision gaps; read the needed section, not the whole file. Current source/scripts/CI outrank dated notes.
- Routine fixes need targeted investigation, not a design document or a chain of planning, ticket, hosting and documentation workflows. Ask about material scope/behavior decisions; do not repeat settled approvals. Delegate only substantial independent work.
- Reuse helpers, preserve types and surface errors; no broad catches or success-shaped fallbacks. Make the simplest complete change, without speculative abstractions or unrelated cleanup. Comment only non-obvious intent/constraints; no narration or commented-out code.
- UI work follows the [workspace design system](docs/design-system.md) and [rajcord-ui](.agents/skills/rajcord-ui/SKILL.md). Preserve keyboard and touch access, reduced motion, immediate loading feedback and uninterrupted typing.
- Web feature work belongs in `apps/web/src/features/<feature>` with co-located tests. Import another feature through its public `index.ts`, type-only `contracts.ts`, or `styles.css`; keep private implementation imports within the owning feature. `app/` owns composition and session/call lifetimes through app-only `composition.ts` entrypoints; `shared/` holds common helpers and typed context adapters. `pnpm lint` enforces these boundaries. See [feature ownership](CONTRIBUTING.md#web-feature-ownership).
- API features compose in `apps/api/src/app.ts`. Keep production dependencies directional: chat may use auth, voice may use auth/database, screen may use auth/voice, and auth bootstrap may use database. Add shared API contracts when adding routes; `pnpm lint` enforces these feature boundaries.

Code map: `apps/api/src/{auth,chat,db,screen,voice}`, `apps/api/src/{app.ts,presence.ts}`, `apps/api/drizzle`, `apps/web/src/{app,features,shared}`, `apps/desktop/src`, `packages/shared/src`, `infrastructure`, `scripts`.

## Invariants

- Preserve database data, credentials and Docker volumes. Never use `down -v`, volume pruning or database resets as repair. Add migrations; never rewrite applied SQL or journal history.
- Development services stay on loopback; public hosting requires deliberate HTTPS/media configuration with PostgreSQL and control endpoints private. Development Compose is not a public deployment recipe.
- Preserve current session/status, trusted-origin and CSRF checks. Socket rooms are not permission grants; recheck private delivery and revocation.
- HTTP schemas are grouped by feature in `packages/shared/src/contracts`; `api-response.ts` composes the route registry and runtime validators. Use the schema-derived browser contract helper for new typed calls. Socket.IO client-event payload schemas are shared in `packages/shared`; keep server and browser transports on those contracts while retaining service authorization and semantic validation.
- Group history requires current membership and the account's membership periods. Only authors edit/delete messages. Preserve send idempotency and sequence ordering.
- Unread cursors are account-private and monotonic; exclude own/deleted/inaccessible messages. Acknowledge only visible, focused reading at the latest messages. Keep updates on authenticated sockets and retain bounded event/request budgets.
- Voice uses session-bound `/media/rtc` leases with JWTs server-side and one reservation per account. Preserve bounded request/queue budgets, revocation/leave cleanup and exact device selection without silent fallback. Screen sharing remains direct P2P. Use the ten-person voice call with one 1080p60 publisher and two viewers as the representative workload. The optional stress target is twenty publishers, each watching all nineteen other sources.
- Preserve Electron sandbox/context isolation, disabled renderer Node integration and origin/main-frame IPC/permission checks. Notification previews contain no message text or participant names. Preferences may use localStorage; authentication tokens may not.
- No credentials, cookies, private messages, environment files, profiles, backups or generated artifacts in commits/diagnostics.

## Delivery and tickets

- All changes follow `feature/* -> develop -> main`. Start new features from safely refreshed `develop`; feature PRs target `develop`, release PRs go `develop` to `main`. No direct commits to shared branches or feature-to-main PRs. Keep the user's active feature branch; never reset/discard work to enforce naming.
- Plan the matching Windows app update whenever a release changes the installed client, its bundled assets, or hosted features that require a newer desktop client. Coordinate the versioned installer and hosted rollout, verify existing-client compatibility, and track the private installer handoff or authorized updater release separately. See [desktop distribution](docs/desktop-distribution.md).
- Automate through scripts and GitHub Actions. Preserve protection/approval gates; only verified `main` may publish/deploy. Before an authorized PR/merge, verify source/base and checks. Before commit/push, inspect the full staged diff, destination and outgoing commit range. No force-push.
- Planning, connecting tools and editing configuration do not authorize tickets, pushes, merges, deployments or purchases. Use existing scoped authorization; confirm missing destination/cost/destructive decisions before acting. See [CONTRIBUTING.md](CONTRIBUTING.md) when performing Git workflow operations.
- Ticket drafts, creation and substantial rewrites use [rajcord-ticket](.agents/skills/rajcord-ticket/SKILL.md) and [the template](docs/ticket-template.md). Check destination/duplicates before publishing; keep personal routing outside the repo. Never invent owners, estimates, dates or completion evidence.

## Verification and handoff

- Add regression tests for implemented behavior, including relevant failures/permissions. Use [rajcord-verify](.agents/skills/rajcord-verify/SKILL.md) for the smallest local checks covering the change and dependent contracts; widen when needed. Never omit required evidence to save tokens. CI is not a substitute for available local checks.
- Documentation-only work needs changed-file formatting, factual/link checks and skill validation where applicable, not application services or runtime suites.
- Update existing docs when behavior/commands change. Record only durable decisions in MEMORY and material new evidence in [docs/verification.md](docs/verification.md), not routine activity logs. Keep handoffs concise: outcome, checks, blockers. Clearly distinguish tested, skipped and historical evidence.
