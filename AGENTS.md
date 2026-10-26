# Tricord agent instructions

Tricord is a private, self-hosted text and voice app for one community of up to ten friends. Work in the existing pnpm monorepo.

## Context and sources

- Read [MEMORY.md](MEMORY.md) for the dated project state and [SKILLS.md](SKILLS.md) to select a relevant workflow. Load only the skills needed for the task.
- Confirm the checkout with `git rev-parse --show-toplevel` and inspect `git status`. The maintainer's Windows checkout is `F:\tricord`; contributors can use their own clone path. Do not recreate the project in the old workspace.
- Current source, package scripts, migrations and CI define executable behavior. [README.md](README.md) describes setup; [docs/verification.md](docs/verification.md) records dated evidence. [docs/decisions.md](docs/decisions.md) includes historical milestone decisions, some superseded by later code.

## Code map

| Location                                 | Responsibility                                                 |
| ---------------------------------------- | -------------------------------------------------------------- |
| `apps/api/src/auth`                      | Account approval, session cookies, CSRF and ownership          |
| `apps/api/src/chat`                      | Conversations, membership periods, messages and unread events  |
| `apps/api/src/db` and `apps/api/drizzle` | PostgreSQL schema, additive migrations and isolated fixtures   |
| `apps/api/src/voice`                     | LiveKit reservations, private control, signaling and tests     |
| `apps/web/src`                           | Shared browser/Electron UI, voice controller and notifications |
| `apps/desktop/src`                       | Electron lifecycle, permissions, preload and validated IPC     |
| `packages/shared/src/index.ts`           | HTTP/socket types and shared mention matching                  |
| `infrastructure` and `scripts`           | Local services, server image and verification helpers          |

## Boundaries that must survive changes

- Preserve existing database data and Docker volumes. Never use `down -v`, volume pruning or a database reset as a repair. Use new migrations; do not rewrite applied migration SQL or journal history.
- Keep development services on loopback. A hosting task must deliberately configure public HTTPS/media access while keeping PostgreSQL and control endpoints private. The development Compose files are not a public deployment recipe.
- Reuse live session/status checks, trusted origins and CSRF handling. Socket rooms are subscriptions, not permission grants. Recheck access for private delivery and account revocation.
- Group history requires current membership and includes only messages within that account's membership periods. Authors alone edit/delete their messages. Preserve send idempotency and sequence-based ordering.
- Unread cursors belong to the account, advance monotonically and reveal no other member's read receipts. Own/deleted messages and inaccessible history do not count. Read acknowledgements require visible, focused reading at the latest messages.
- Keep real-time unread updates on authenticated sockets and retain bounded request/event budgets. Do not solve ordinary synchronization load by broadly raising or disabling abuse protection.
- Voice uses opaque session-bound leases through `/media/rtc`; usable LiveKit JWTs stay server-side. Preserve one active voice reservation per account, the ten-person cap and cleanup on revocation/leave. Exact selected audio devices must not silently fall back.
- Preserve Electron sandbox/context isolation, disabled renderer Node integration and origin/main-frame checks for permissions and IPC. Notification previews contain no message text or participant names; opt-in preferences may use localStorage, authentication tokens may not.
- Keep credentials, cookies, personal messages, environment files, profiles, backups and generated artifacts out of commits and diagnostics. Reuse existing dependencies where practical; explain any necessary addition.

## Verification and handoff

Use [tricord-verify](.agents/skills/tricord-verify/SKILL.md) to choose checks proportional to the change. Documentation-only work needs formatting, factual/link checks and skill validation when applicable; it does not need Docker or the full runtime suite. Distinguish completed checks from historical evidence and untested behavior.

Update README for changed user commands/behavior and MEMORY for durable project decisions. Keep test-run detail in docs/verification.md. Communicate outcomes and remaining limitations in plain language.

Before a requested commit/push, inspect the complete staged diff, destination and full outgoing commit range/content, including earlier unpushed work. Confirm that everything being published falls within the user's existing authorization; do not request it again for work already covered. These files do not grant standing permission for future pushes, deployments or purchases. Never force-push or discard unrelated work to make publication succeed. Prepare a concrete server configuration and cost before asking for any missing hosting purchase/deployment approval.
