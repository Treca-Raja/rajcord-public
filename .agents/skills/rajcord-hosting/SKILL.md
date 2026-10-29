---
name: rajcord-hosting
description: Use for Rajcord packaging, CI/release policy, hosting readiness or explicitly authorized production operations.
---

# Rajcord hosting work

Choose the entry point for this task; do not preload all hosting documents:

- Image change: affected [Dockerfile](../../../infrastructure/server/Dockerfile) stages and packaging scripts.
- Release change: affected [CI](../../../.github/workflows/verify.yml), policy and regression tests.
- Architecture/state question: relevant [hosting](../../../docs/hosting.md) or dated [MEMORY](../../../MEMORY.md) section.
- Live operation: read the relevant [deployment runbook](../../../docs/deployment.md) procedure and script before execution, including its prerequisites/recovery steps.

## Release boundary

- PRs/feature/develop do not publish or deploy. `HOSTING_ENABLED=true` enables trusted current-main delivery of the exact tested digest after production approval. `publish_only=true` skips both production jobs regardless of that variable.
- Keep `Treca-Raja/rajcord-public`, `ghcr.io/treca-raja/rajcord-public`, the policy allowlist, publishing tag and tests consistent. Verify organization package access and host pull credentials before release; transfer alone proves neither. Never put CI's write token on the VPS.
- API/web share a non-root server image; PostgreSQL/LiveKit are separate services. No runtime secrets in image layers/build context. No per-component switches exist; use the deployment-option skill only when adding them.
- Preserve existing gates, storage, migrations and rollback compatibility when changing runtimes/images/database/LiveKit versions.

## Operations

Local preparation is not authorization to publish, deploy or purchase. For authorized work, verify the actual target, access, scope and cost; stop on mismatches. Use the existing production host without provisioning staging from an obsolete plan. Dated notes are not live evidence.

Follow the runbook instead of copying its host/TLS/backup commands here. Preserve initialized credentials/runtime directories, private PostgreSQL/API/LiveKit control, exact proxy trust and `/media/rtc`. Retain deployment locks, pre-migration encrypted off-server backups, readiness checks and data-compatible recovery.

Before SSH/firewall changes, require independent key access, rollback protection and post-change verification. Treat the CI deploy user's access as privileged. Verify HTTPS issuance/renewal, actual RTC addressing, backup restore, maintenance and cross-network voice where affected; local fixtures do not establish those properties. Do not promise capacity from advertised specs.

## Evidence

Release-only changes need focused release tests, workflow validation and applicable lint/type checks. Image changes need `pnpm server:build` and `pnpm test:server-image`; hosting/proxy/deployment changes also need `pnpm test:hosting`. Use disposable fixtures. Do not run the stack for documentation-only changes.

Report what was actually built/published/deployed and outstanding live checks. Read the verification skill only when selecting unfamiliar checks or diagnosing a failure, not as another mandatory document chain.
