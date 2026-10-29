---
name: rajcord-document-change
description: Use when documenting changed Rajcord features, behavior, commands or decisions; update existing sections with verified facts.
---

# Document a Rajcord change

Use the actual change/tests already in context. Open only the relevant section of the existing document:

- [README](../../../README.md): features, visible behavior, setup and commands.
- [CONTRIBUTING](../../../CONTRIBUTING.md): branches and contributor workflow.
- [Hosting](../../../docs/hosting.md) / [deployment](../../../docs/deployment.md): architecture and operator procedures.
- [MEMORY](../../../MEMORY.md): durable decisions; [verification](../../../docs/verification.md): material new evidence.
- [AGENTS](../../../AGENTS.md) / [SKILLS](../../../SKILLS.md): changed agent rules or discovery.

Describe implemented behavior, users, prerequisites, limits and failures. Verify commands against the relevant script/package manifest; distinguish platforms where necessary. Link canonical procedures rather than duplicating them or creating another report. Separate documents require a request.

Preserve dated history; do not turn old tests into current evidence or append routine activity logs. Keep private data and workstation-specific values out of examples. Sparse code comments explain intent, not user documentation.

Check changed-file formatting, relative links and factual commands. Validate changed skill manifests if applicable. No application services/runtime tests for documentation-only changes; report any unverified example.
