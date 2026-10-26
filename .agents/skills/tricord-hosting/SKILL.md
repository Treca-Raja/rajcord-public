---
name: tricord-hosting
description: Prepare or verify Tricord's Linux server image and cloud-hosting configuration, assess provider/readiness gaps, or carry out an already authorized deployment of the app, PostgreSQL and LiveKit.
---

# Tricord hosting work

Read [AGENTS.md](../../../AGENTS.md), the dated [MEMORY](../../../MEMORY.md), [hosting plan](../../../docs/hosting.md), [server Dockerfile](../../../infrastructure/server/Dockerfile) and current [CI](../../../.github/workflows/verify.yml). Verify live repository/server state; documentation of a prepared image is not proof of a deployed service.

## Existing build boundary

Run `pnpm server:build` and `pnpm test:server-image` when image/deployment behavior changes. The local tag is `tricord-server:alpha`. The image serves the built web UI and Fastify API as a non-root user; PostgreSQL and LiveKit are separate services. The smoke checks migrations, auth/cookies, private media control and dump/restore in disposable containers. Do not put runtime credentials in the build context or image layers.

GitHub stores source and runs verification; the current workflow neither deploys nor publishes an image. Inspect pending commits and the remote before an authorized source push. Publishing an image to a registry is a separate action from building it locally.

## Prepare a concrete deployment

The current preference is one low-cost, always-on Linux VPS near the group with a stable public IP and free certificates, without buying a domain. Compare current provider terms, total cost including taxes/IP/backup/traffic and actual regional availability. Distinguish annual-prepayment advertisements from monthly billing. Size by measured CPU, memory, network and voice behavior; do not promise ten-person performance from a plan's specifications alone.

Prepare production service configuration with persistent database storage, restart policies and private service networking. Expose only intended HTTPS and media/relay ports. Keep PostgreSQL, the API's direct listener and LiveKit control private; do not publish the development Compose files unchanged. Retain the authenticated /media/rtc gateway.

Create separate production secrets through secure runtime configuration. NODE_ENV=production requires HTTPS origins and supports the private LiveKit service address. Built Electron accepts an exact HTTPS TRICORD_SERVER_URL; the development launcher continues to target Vite.

For IP-only HTTPS, verify the current [Let's Encrypt IP guidance](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) and ACME client support, then test automated renewal, service reload and expiry monitoring. Validate the actual RTC public addressing and TURN/TLS configuration against the selected IP/proxy arrangement; the local image smoke does not cover that path.

Include owner initialization, scheduled private off-server database backups, retention and a tested restore; log rotation/disk monitoring; update and rollback steps that respect migration/data compatibility. Establish HTTPS/session behavior and voice between separate networks with two or three people before expanding to ten.

## Execution scope

Preparing configuration and running local tests does not purchase a server or authorize public deployment. Use the user's existing authorization; where cost, destination or access is still missing, finish the reviewable configuration and exact proposed terms first, then request only the missing decision/access. Never infer credentials or place them in Git, a public issue or a chat transcript.

When deployment is authorized and access exists, inspect the actual target, preserve existing data, apply the prepared change and verify it there. Stop if the target, billing terms or destructive consequences differ from what was authorized. Report what was actually provisioned, published or deployed, and which remote-network/backup checks remain unverified.
