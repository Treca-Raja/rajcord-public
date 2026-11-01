---
name: rajcord-plan-change
description: Use for substantial Rajcord designs, architecture or cross-component planning; map dependencies and define tasks and acceptance criteria.
---

# Plan a Rajcord change

Not needed for a routine fix with clear scope. Follow active repository instructions without rereading them.

1. Establish the outcome, non-goals and measurable acceptance criteria; clarify material behavior/cost/scope decisions without inventing thresholds.
2. Inspect affected source and contracts only. Trace relevant API, UI, Electron, shared types, database, voice, identity/network and CI dependencies. Use [package.json](../../../package.json) or [CI](../../../.github/workflows/verify.yml) only when those surfaces matter. API and web share an image; directories do not imply independently deployable components.
3. Consult relevant [MEMORY](../../../MEMORY.md) sections only for unresolved historical/hosting decisions. Separate current evidence, dated claims and assumptions; planning alone does not authorize live inspection.
4. Recommend the simplest complete solution using existing helpers. Compare alternatives only for real trade-offs; cover affected contracts, schema, compatibility, capacity, privacy and recovery.
5. Give dependency-ordered tasks with affected files, acceptance criteria, relevant local checks, documentation and rollout/rollback. Preserve `feature/* -> develop -> main`, approval gates and the exact-tested-image release boundary.

Return the recommendation, evidence, tasks and unresolved risks concisely. Stop at a proposal when planning was requested; implement only within explicit authorization. Use the ticket skill only if tickets are requested, verification when choosing/running checks, and documentation when updating docs. Do not launch all downstream workflows or create a separate plan/ADR automatically.
