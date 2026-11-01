---
name: rajcord-deployment-option
description: Use when adding or changing future boolean Rajcord deployment switches across GitHub Actions and scripts.
---

# Add a Rajcord deployment option

No component selectors exist yet; this skill describes future work.

1. Confirm component, true/false semantics, defaults, triggers and environments. API/web share an image; PostgreSQL/LiveKit have state/configuration dependencies. Agree on material design changes before implementation.
2. Define valid combinations. False skips work, never deletes data, stops existing services or uninstalls resources. Prefer false for new opt-in actions without silently changing normal-release defaults; reject unsafe combinations explicitly.
3. Trace the affected [CI](../../../.github/workflows/verify.yml) input through conditions and arguments to the operation in [deployment orchestration](../../../scripts/ci/deploy.mjs). Inspect [release policy](../../../scripts/ci/policy.mjs) for gate interactions, not unrelated hosting files.
4. Parse booleans explicitly, including absent non-dispatch inputs. A string `false` is not truthy-enabled; invalid values fail clearly. Reuse helpers and preserve ordering, idempotency, backup/migration dependencies and rollback.
5. Preserve `HOSTING_ENABLED`, current-main checks, immutable tested images, production approvals and `publish_only`. Component selection never authorizes publication/deployment.
6. Add local tests for true/false/missing/invalid inputs, combinations and repeated execution. Assert skipped operations are not called and feature/develop cannot publish or bypass gates. Use mocks/disposable fixtures and relevant workflow/release checks, not a live dispatch.
7. Update the relevant [runbook](../../../docs/deployment.md) section with defaults, effects and dependencies, without secrets. Report live-only verification separately.
