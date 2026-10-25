# Hosted alpha preparation

The active source repository is public at [fakebane/tricord-public](https://github.com/fakebane/tricord-public), with automated verification. The previous private repository is retained as an archived predecessor. The server image is tested locally. No cloud server, TLS endpoint or internet-facing deployment has been provisioned yet. The selected direction is IP-only hosting with free, automatically renewed public-IP certificates; no domain purchase is planned.

## What is ready

- A multi-stage Linux image builds the existing application and runs only the API/web runtime as the non-root node user. Node base images and CI actions are pinned.
- Docker build context excludes Git history, local environments, artifacts, node_modules, backups and local desktop profiles. Runtime packages include built code and migrations.
- CI runs formatting, lint, TypeScript, unit tests, real PostgreSQL/LiveKit integration tests, the production build and the server-image smoke. It has read-only repository permissions and does not deploy.
- The image smoke uses an isolated Docker network, a PostgreSQL tmpfs and a separate LiveKit container. It verifies migrations twice, web assets, database readiness, registration/login, Secure/HttpOnly/SameSite cookies, pending-account restrictions, authenticated private LiveKit control, and an actual pg_dump/pg_restore round trip.
- Production voice configuration accepts the private Docker hostname livekit. Browser connections still pass through the authenticated Tricord signaling gateway; LiveKit bearer tokens remain internal.
- Hosted leases let LiveKit supply ICE/TURN configuration. Development leases retain an empty ICE-server list and loopback-only configuration.
- Desktop can load an operator-configured exact HTTPS origin. Its microphone permissions, navigation restrictions and renderer isolation use that same trusted origin. Temporary-cookie cleanup is scoped to the selected server.

## Local image verification

Docker Desktop must be running:

```powershell
Set-Location F:\tricord
pnpm server:build
pnpm test:server-image
```

The smoke creates random test credentials and a temporary environment directory. It publishes only the disposable API port on 127.0.0.1, and cleans up its own containers/network/files. PostgreSQL uses tmpfs, so no Docker volume is created or removed. Real development accounts, credentials and volumes are untouched. This test exercises production application settings over local HTTP with an explicit HTTPS Origin header; it does not certify a public TLS endpoint or WAN media routing.

## Proposed first deployment

Use one Linux x86-64 VPS near the group, with an initial private alpha for two or three friends. A Germany region is a reasonable first candidate for a group mostly in Europe; actual latency and voice stability must be measured.

```mermaid
flowchart LR
  Friend[Browser or desktop] -->|HTTPS and WSS| Proxy[TLS reverse proxy]
  Proxy --> API[Tricord API and web assets]
  API --> DB[(Private PostgreSQL)]
  API -->|Private control and signaling| Media[LiveKit]
  Friend -->|Encrypted RTC media| Media
  Friend -->|Relay when needed| TURN[TURN service]
  TURN --> Media
```

Only the reverse proxy and required media/relay ports should be public. PostgreSQL, the API's direct port and LiveKit control must remain on the private container network. Do not deploy the development Compose files unchanged.

Production API configuration will supply NODE_ENV=production, WEB_ORIGINS=https://the-public-ip, DATABASE_URL for the private postgres service, and LIVEKIT_URL=http://livekit:7880 with freshly generated API credentials. Production never loads the workstation's infrastructure/.env.voice. Do not reuse development passwords or commit generated configuration.

After the server exists, desktop can target it with:

```powershell
$env:TRICORD_SERVER_URL = "https://YOUR_PUBLIC_IP"
pnpm --filter @tricord/desktop start
```

Use the built desktop command for this; dev:desktop deliberately continues to use the local development origin.

## Required before inviting friends

1. Select a low-cost Linux VPS, region and stable public IPv4 address; review the actual checkout total and billing term.
2. Provision the server and SSH access, with an explicit deployment firewall.
3. Configure a trusted TLS reverse proxy for the public IP, automatic certificate renewal with service reload and expiry monitoring, public RTC addressing and TURN/TLS fallback. Keep LiveKit control behind the existing authorization gateway.
4. Generate separate production secrets and initialize the production owner locally on the server.
5. Schedule PostgreSQL dumps to private storage outside the VPS, define retention, and test restoration there. The local image smoke proves dump compatibility, not off-site backup automation.
6. Configure restart policies, disk monitoring, log rotation and the update/rollback procedure.
7. Test HTTPS cookies, desktop connectivity, unauthorized media access and real voice between separate networks. Then expand from two or three users to ten.

No hosting purchase or deployment is performed by the CI workflow. A cloud account, selected server and server access are still required to finish these steps.

## Low-cost IP-only direction

The user selected free certificates and the lowest practical recurring cost while preserving voice performance. No paid domain, commercial certificate, managed database or extra server is planned for the first alpha. The cloud VM remains a paid service; no purchase has been authorized at a final checkout price or made.

Use a single x86-64 Linux VPS near the group. A 4-vCPU/8-GB configuration is a candidate with useful headroom for the API, PostgreSQL, LiveKit and operating system. This is a sizing estimate, not a guarantee: CPU sharing, network routing and loss can matter more than advertised RAM. Validate two or three remote participants first, then ten; monitor CPU, memory, audio loss/jitter, reconnects and API responsiveness. Preserve audio quality and user capacity rather than reducing them to fit an undersized server.

Price/availability research on 2026-10-25 found that [Hetzner's cost-optimized plans](https://www.hetzner.com/cloud/cost-optimized/) were advertised as unavailable. [OVHcloud's Ireland VPS page](https://www.ovhcloud.com/en-ie/vps/) advertises VPS-2 with 4 vCores, 8 GB RAM, 75 GB NVMe, 1 Gbps public bandwidth, unlimited traffic and a daily previous-24-hour backup from EUR 7.21/month excluding VAT. This is an advertised starting price, not a validated order or a reservation; check regional availability, IPv4 inclusion, billing commitment, renewal price and taxes at checkout. Keep application-consistent PostgreSQL backups in addition to a VM backup.

[Let's Encrypt public-IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) are free and valid for 160 hours. Use an ACME client that supports public IPs and the shortlived profile. [Certbot's IP-certificate guide](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) documents webroot validation and the need for a deployment hook to reload services. Renewal, reload and expiry checks must be automated before real users depend on the server. These operations still need verification against the chosen public IP and deployed reverse proxy/relay.

## Repository publication review

Before the first GitHub upload, seven existing commits and 182 unique historical file blobs were checked for tracked environment/profile files, configured database/LiveKit secret values, private keys and high-confidence credential patterns. No matches were found. This is a scoped review, not a guarantee that arbitrary historical secrets can be detected.

At the user's request, the active project moved to a new public repository with its existing Git history. Before publication, all nine preceding commits and 202 historical file versions were checked again for the configured database/LiveKit secret values, private runtime paths, private keys and high-confidence credential patterns; no matches were found. Commit email addresses use GitHub's noreply format. The predecessor remains private and archived. Local environment files and generated credentials stay on the workstation.
