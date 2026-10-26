---
name: tricord-verify
description: Select and run Tricord's local verification for code, configuration or documentation changes, and diagnose failed project checks without damaging development data.
---

# Verify a Tricord change

Work from the existing repository root. Read [AGENTS.md](../../../AGENTS.md), the relevant [README](../../../README.md) section and [package.json](../../../package.json). Use the current scripts rather than copying an old test count from memory.

## Choose the needed evidence

| Change                                                    | Appropriate checks                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Markdown/instructions only                                | `pnpm format:check`, verify links and factual commands; validate changed skills             |
| Runtime code or workspace configuration                   | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`               |
| Persistence, auth, chat or permission behavior            | Above plus `pnpm test:db` with relevant regression cases                                    |
| Browser auth/chat/unread/notification flows               | `pnpm test:browser`                                                                         |
| Electron lifecycle, preload, permissions or notifications | `pnpm test:desktop`                                                                         |
| Voice transport/devices/recovery                          | `pnpm test:voice`; add `pnpm test:voice:load` for capacity, recovery or rate-budget changes |
| Server packaging, migrations or backup compatibility      | `pnpm server:build` then `pnpm test:server-image`                                           |

Combine rows that apply. Do not start services or rerun unrelated runtime suites for a documentation-only change. After a focused failure is fixed, rerun the affected check; repeat broader checks only when the fix or unresolved evidence justifies it.

## Local prerequisites

Use the Node/pnpm versions declared by the workspace. If dependencies are missing, install with `pnpm install --frozen-lockfile`. Type checking builds shared packages before tests; when running a runtime test alone on a fresh checkout, run `pnpm build:packages` first. Electron verification also needs its binary, installed by `pnpm setup:desktop` when absent.

The database suite and browser/desktop/voice smokes need local PostgreSQL and LiveKit. The PostgreSQL test role also needs `CREATEDB` permission for isolated test databases; the default development Compose role provides it. For missing initial configuration, use the existing `pnpm db:setup` and `pnpm voice:setup`; preserve existing credentials. Start Docker Desktop on Windows if stopped, then from the root:

```powershell
pnpm db:up
pnpm voice:up
pnpm db:migrate
```

Root smoke commands build first. After an already verified build, the matching `pnpm --filter @tricord/api test:browser` / `test:desktop` / `test:voice` commands avoid another build. Browser automation defaults to installed Windows Edge; `TRICORD_BROWSER_PATH` selects another supported Chromium executable. Linux CI does not certify the Windows UI.

## Interpret and report

Check the actual process exit status and complete test summary. A container being running does not establish database readiness or working voice. Missing Docker/services should be fixed or reported as prerequisites, not represented as application-test failures or passing checks.

The image smoke owns disposable containers, a network and a tmpfs database. Other integration fixtures use uniquely named temporary databases/profiles and media prefixes; clean only their owned resources. Never use volume deletion as cleanup. Service shutdown uses `pnpm voice:down` and `pnpm db:down` only when appropriate to the task, without `-v`.

Report new failures separately from the known lazy LiveKit bundle/legacy deploy advisories. Record substantial new evidence in [docs/verification.md](../../../docs/verification.md), with its limits. Claim neither physical-device nor internet-wide voice coverage from synthetic local tests.
