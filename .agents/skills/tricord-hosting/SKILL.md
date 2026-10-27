---
name: tricord-hosting
description: Prepare or verify Tricord's Linux server image and cloud-hosting configuration, assess provider/readiness gaps, or carry out an already authorized deployment of the app, PostgreSQL and LiveKit.
---

# Tricord hosting work

Read [AGENTS.md](../../../AGENTS.md), the dated [MEMORY](../../../MEMORY.md), [hosting plan](../../../docs/hosting.md), [deployment runbook](../../../docs/deployment.md), [server Dockerfile](../../../infrastructure/server/Dockerfile) and current [CI](../../../.github/workflows/verify.yml). Verify live repository/server state; documentation of a prepared image is not proof of a deployed service.

## Existing build boundary

Run `pnpm server:build`, `pnpm test:server-image` and `pnpm test:hosting` when image/deployment behavior changes. The local tag is `tricord-server:alpha`. The image serves the built web UI and Fastify API as a non-root user; PostgreSQL and LiveKit are separate services. The smokes check migrations, auth/cookies, private media control, dump/restore, real fixture TLS and deployment failure handling in disposable containers. Do not put runtime credentials in the build context or image layers.

GitHub verification remains read-only for pull requests. With repository variable HOSTING_ENABLED=true, trusted main runs publish the exact CI-tested image and deploy its digest after the production environment approval. Disposable CI environments replace a permanent staging host in the current plan. Inspect the actual variable, production environment and protection rules before assuming delivery is enabled. Inspect pending commits and the remote before an authorized source push. Publishing an image or enabling delivery is separate from building locally.

For first-release registry preparation, the manual Verify workflow input publish_only=true tests/publishes the current-main image while skipping both production jobs, regardless of HOSTING_ENABLED. Use it to establish GHCR access before enabling delivery. New packages default to private; public visibility or a separate read-only host credential requires deliberate setup. Do not place CI's write token on the VPS.

## Prepare a concrete deployment

The user has an AlphaVPS C4G production VPS and the Cloudflare-managed domain rajcord.com. Current preference is one production host without permanent staging. Recheck the actual host before changes. Initialization accepts optional web/TURN hostnames after its environment, public IPv4 and runtime-directory arguments; preserve the IP for RTC advertisement and use the domain names for TLS/app origins. Configure DEPLOY_HTTPS_HOST separately from the SSH host IP in the production GitHub environment. Do not provision another server from the older staging plan. Assess CPU, memory, disk, network and voice behavior on the existing plan; do not promise ten-person performance from advertised specifications alone. If more resources are needed, prepare the concrete change and current cost first.

Reuse infrastructure/hosting and scripts/hosting for persistent storage, private service networking, deploy locks, pre-migration encrypted off-server backups and readiness checks. Expose only intended HTTPS and media/relay ports. Keep PostgreSQL, the API's direct listener and LiveKit control private; do not publish the development Compose files unchanged. Retain the authenticated /media/rtc gateway and exact trusted proxy peer. Runtime initialization refuses overwrite; preserve existing credentials.

For a fresh Ubuntu 24.04 host, review prepare-host.sh/firewall.sh before applying them. They use the official Docker apt repository, UFW input rules and an owned DOCKER-USER chain matching original destination ports; verify forwarding from outside and after Docker restart. Apply harden-ssh.sh only after independent key access works, with rollback protection and a fresh post-reload login. configure-deploy-user.sh installs a separate CI public key; its sudo/release-directory access is effectively privileged. initialize-runtime.sh generates secrets with the pinned Node container without installing host Node. Preserve /etc/tricord/production once initialized. See MEMORY for the actual host state instead of rerunning initial setup blindly.

Create separate production secrets through secure runtime configuration. NODE_ENV=production requires HTTPS origins and supports the private LiveKit service address. Built Electron accepts an exact HTTPS TRICORD_SERVER_URL; the development launcher continues to target Vite.

For the domain arrangement, use DNS-only Cloudflare A records for the app and TURN hostnames initially, then verify public HTTP-01 issuance, automated renewal, service reload and expiry monitoring. The bootstrap helper selects domain SANs or the short-lived IP profile from runtime markers; do not regenerate an existing runtime directory to change identities. For IP-only fallback, verify current [Let's Encrypt IP guidance](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) and client support. The prepared TURN/TLS listener uses 5349; networks requiring relay TLS on 443 need a separate tested arrangement. Validate public certificates, actual RTC addressing and cross-network media; local fixture TLS does not certify those paths.

Include owner initialization, scheduled private off-server database backups, retention and a tested restore; log rotation/disk monitoring; update and rollback steps that respect migration/data compatibility. Establish HTTPS/session behavior and voice between separate networks with two or three people before expanding to ten.

## Execution scope

Preparing configuration and running local tests does not purchase a server or authorize public deployment. Use the user's existing authorization; where cost, destination or access is still missing, finish the reviewable configuration and exact proposed terms first, then request only the missing decision/access. Never infer credentials or place them in Git, a public issue or a chat transcript.

When deployment is authorized and access exists, inspect the actual target, preserve existing data, apply the prepared change and verify it there. Stop if the target, billing terms or destructive consequences differ from what was authorized. Report what was actually provisioned, published or deployed, and which remote-network/backup checks remain unverified.
