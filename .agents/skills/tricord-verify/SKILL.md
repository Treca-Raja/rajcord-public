---
name: tricord-verify
description: Use to select/run Tricord checks or diagnose test failures; cover changed behavior with local, data-safe evidence.
---

# Verify a Tricord change

Use current [package scripts](../../../package.json), not historical counts. Do not preload README/MEMORY; consult the relevant setup section only for missing prerequisites.

## Select checks by impact

Add regression tests for implementations: success, relevant failures, permissions and compatibility. Reproduce the old bug when practical. Reuse fixtures; never weaken assertions or add sleeps for a pass.

- **Docs only:** `pnpm exec prettier --check <changed-files>`, factual/relative-link checks, and changed skill YAML/name/description validation. No application services/runtime suites.
- **Code:** focused `pnpm exec vitest run <test-files>` plus affected lint, type and build checks. Include dependent contracts. Use supported package/file selectors; widen for cross-cutting changes, uncertain coverage or unavailable focused checks. Full commands remain `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm format:check`.
- **Persistence/auth/chat/permissions:** relevant regressions plus `pnpm test:db`.
- **Browser flows:** `pnpm test:browser`; **Electron lifecycle/IPC/permissions:** `pnpm test:desktop`.
- **Voice behavior:** `pnpm test:voice`; capacity/reconnect/rate-budget changes also need `pnpm test:voice:load`.
- **Release policy/registry/workflow:** `pnpm exec vitest run scripts/release-policy.test.ts`, workflow validation and affected lint/type checks. No image smoke unless image/deployment behavior changes.
- **Image/migration/backup compatibility:** `pnpm server:build` then `pnpm test:server-image`. **Hosted proxy/service/deployment:** also `pnpm test:hosting` and CI's relevant workflow/shell validators.

Combine relevant selectors in one run. Reuse successful evidence/builds only while inputs and environment remain unchanged; rerun after relevant changes or unresolved failures. Never drop necessary checks to save time. CI retains its full checks.

## Prerequisites, only when needed

- Use declared Node/pnpm versions and existing tools. Restore missing dependencies with `pnpm install --frozen-lockfile`; do not reinstall for every task. Runtime tests needing unbuilt shared packages require `pnpm build:packages`; Electron needs `pnpm setup:desktop` if its binary is absent.
- Integration/UI/voice suites need local PostgreSQL/LiveKit and a test role with `CREATEDB`. For absent initial config use `pnpm db:setup` / `pnpm voice:setup`, preserving credentials. Start Docker if needed, then `pnpm db:up`, `pnpm voice:up`, and inspect the target before `pnpm db:migrate`. Full setup is in [README](../../../README.md).
- Root UI/voice smoke commands build first. After an unchanged verified build, matching `pnpm --filter @tricord/api test:browser`, `test:desktop` or `test:voice` avoids rebuilding. Browser automation defaults to Windows Edge; `TRICORD_BROWSER_PATH` selects supported Chromium.
- For upgrades, check affected Node/pnpm, Electron/browser, PostgreSQL/Drizzle, LiveKit and image compatibility; preserve the lockfile.

## Evidence and cleanup

Verify exit status, assertions and the full relevant summary. Report missing prerequisites, actual failures and skipped checks distinctly; a running container is not readiness. Do not claim CI, physical-device, Windows or WAN coverage from unrelated local checks.

Use disposable fixtures and clean only owned resources; never delete development volumes. The hosted smoke uses fixture TLS and mocked operator commands, not real SSH/backups. Shut down local services only when appropriate, via `pnpm voice:down` / `pnpm db:down` without `-v`.

Report new failures separately from known advisories. Record material new evidence in [verification notes](../../../docs/verification.md), with its limits; do not append routine repeated checks or copy old counts as current results.
