---
name: rajcord-database
description: Use for Rajcord PostgreSQL/Drizzle persistence, migrations, database fixtures or recovery; preserve existing data.
---

# Rajcord database work

Inspect the affected service/query; read [schema](../../../apps/api/src/db/schema.ts) and migration journal only where relevant. Keep current data and credentials.

## Schema and migration changes

- Change schema, run `pnpm db:generate`, and inspect SQL, snapshot and journal together. Add migrations; never edit applied ones. Check defaults, foreign keys, uniqueness and existing-row compatibility. Generated destructive SQL is not permission to execute it; destructive work needs explicit scope and backup/recovery.
- Inspect the local target and migration before `pnpm db:migrate`. Verify constraints, disposable read/write behavior and a second migration run. Update [migration expectations](../../../apps/api/src/db/database.integration.test.ts) when intentionally changed.
- Preserve membership-period visibility and monotonic per-account unread cursors excluding own/deleted/inaccessible messages. Timestamps or cached socket membership never replace authorization.

## Test ownership and recovery

- Reuse [testDatabase](../../../apps/api/src/db/test-database.ts): loopback-only random `tricord_test_` fixtures, closed before dropping. The foundation suite deletes only its own unique rows in the development database. Never truncate/drop development data or recreate volumes.
- Run relevant regressions; the full `pnpm test:db` suite needs PostgreSQL and LiveKit. Use the verification skill's prerequisite section only when needed. Connection refusal calls for service/readiness checks, not schema repair. Do not print DATABASE_URL or expanded Compose secrets.
- `pnpm db:verify-persistence` restarts the existing PostgreSQL container: use only for restart-recovery work and coordinate with active users. It must preserve the development journal.
- Backup/deployment compatibility needs `pnpm server:build` and `pnpm test:server-image`. Disposable dump/restore evidence is not a scheduled production backup or live restore.
