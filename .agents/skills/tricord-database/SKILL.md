---
name: tricord-database
description: Change or troubleshoot Tricord's PostgreSQL/Drizzle persistence, additive migrations, database integration fixtures and recovery checks while preserving existing data.
---

# Tricord database work

Read [AGENTS.md](../../../AGENTS.md), [schema.ts](../../../apps/api/src/db/schema.ts), the affected service and the existing migration journal under apps/api/drizzle/meta. Keep current development data and credentials intact.

## Schema and migration changes

Change the Drizzle schema, run `pnpm db:generate` and inspect the generated SQL, snapshot and journal together. Add a migration rather than editing applied files. Check defaults, foreign keys, uniqueness and existing-row compatibility; a generated destructive statement is not permission to execute it. Design an explicitly requested destructive data change separately with a concrete backup/recovery plan.

Apply with `pnpm db:migrate` against the configured local database only after inspecting the target and migration. Verify expected tables/constraints, disposable insert/read/delete behavior and a second migration run with no unintended changes. Keep current-migration expectations in [database.integration.test.ts](../../../apps/api/src/db/database.integration.test.ts) consistent with intentional schema additions.

Membership sequence ranges define private message visibility. Persisted read cursors advance monotonically per user/conversation and must not count own, deleted or inaccessible messages. Preserve these semantics when changing queries, indexes or synchronization; timestamps and cached socket membership are not authorization substitutes.

## Test ownership and recovery

[The testDatabase helper](../../../apps/api/src/db/test-database.ts) validates loopback access, creates a random `tricord_test_` database and drops only that fixture after closing connections. Use it for integration scenarios; the foundation suite owns and deletes only its unique rows in the configured development database. Do not substitute truncation, dropping the development database or recreating a Docker volume.

Use [tricord-verify](../tricord-verify/SKILL.md) for prerequisites and relevant checks. The full database suite also exercises LiveKit, so start both local services. If connection is refused, check Docker and service readiness before attempting schema repair. Do not print DATABASE_URL or expanded Compose environment values.

`pnpm db:verify-persistence` deliberately restarts the existing PostgreSQL container; use it when restart recovery is part of the task and coordinate around any active local work. It owns a disposable database and verifies that the development migration journal is preserved. It is unnecessary for routine documentation edits.

For deployment/backup compatibility, use `pnpm server:build` and `pnpm test:server-image`. The image smoke checks real dump/restore, including a saved read cursor, in disposable containers. These local checks do not create scheduled off-server production backups. Record that distinction in the handoff.
