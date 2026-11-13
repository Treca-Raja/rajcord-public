# Milestone 2C verification

Windows 11, 2026-10-24. Active repository: F:\tricord. Milestone 2B commit d298aa9 retained.

| Check                      | Result                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                 | Healthy existing PostgreSQL 17 service; 127.0.0.1:5432 only                                                      |
| LiveKit                    | Pinned 1.13.10 local container; control/TCP/UDP ports bound only to 127.0.0.1                                    |
| Migrations                 | 0000–0002 unchanged; additive 0003 creates voice_channels and seeds The lounge                                   |
| Schema                     | Ten public tables; repeat migration execution is safe; generation reports no drift                               |
| Unit/regression tests      | 24 passing                                                                                                       |
| Database integration tests | 80 passing: 7 database, 29 authentication, 29 messaging, 15 voice                                                |
| Total Vitest tests         | **104 passing**                                                                                                  |
| Existing Edge checks       | 22 authentication/messaging checks preserved                                                                     |
| Voice Edge checks          | 17 checks using two independent real Edge processes and synthetic audio                                          |
| Electron checks            | 23 across three actual launches, including real microphone publication and camera denial                         |
| Persistence                | Actual PostgreSQL restart preserves voice channels and existing messaging/authentication fixtures; pools recover |
| Static verification        | Formatting, lint, TypeScript and production builds pass                                                          |
| Dependency verification    | Peer checks and production audit pass                                                                            |

## Real voice evidence

The browser smoke creates a disposable PostgreSQL database, unique LiveKit room prefix and two isolated Edge profiles. Both approved accounts select concrete fake devices through the rendered controls, join muted, unmute and receive actual audio bytes through the media server. Its synthetic WAV input is generated in the temporary test profile; it never opens a physical microphone.

Checks cover session separation, explicit input/output selection, bidirectional audio, microphone-only server grants, mute propagation, deafen playback suppression, signaling reconnect, retained mute preference, simulated microphone loss without fallback, suspension removal, cached-credential rejection, manual leave, expired-reservation recovery, actual Fastify API restart and both clients recovering, per-participant volume and missing-output muting.

The test inspects real WebRTC receive statistics and LiveKit participant tracks. It does not establish subjective audio quality, WAN latency, ten-person performance or hardware hot-unplug behavior. The selected speaker-loss simulation verifies application behavior after a device-change notification.

Reports/screenshots are ignored under artifacts/: voice-browser.json, voice-browser.png, auth-browser.json, messaging-browser.json and auth-desktop.json. The voice screenshot was visually reviewed. No passwords or media bearer tokens are written to reports.

## Authorization and lifecycle coverage

Database-backed voice tests exercise approved-only access, channel persistence and unique names, Origin/CSRF validation, one account across concurrent devices, idempotent reservation retry, explicit leave before switching, opaque client credentials, microphone-only grants, binary/JSON refresh-token sanitization, session binding, wrong-session leave protection, heartbeat expiry, session revocation, suspension and unauthorized gateway Origin.

Client regressions verify explicit device requirements, exclusion of Default/Communications aliases, cancellation while join is pending, missing-device behavior and deafen preserving the mute preference. Electron policy tests reject camera, screen, foreign-origin and embedded-frame requests. The real Electron harness additionally confirms camera getUserMedia is denied while an explicitly selected synthetic microphone reaches LiveKit.

Existing authentication/messaging tests remain intact: private DM and group history access, author-only edits/deletes, idempotency, reconnection, account state changes, cookie/CSRF protections and data preservation.

## Infrastructure and limits

The Docker Desktop media experiment initially failed ICE negotiation because loopback candidate collection inside the container produced duplicate mapped addresses. Disabling container loopback candidates while retaining explicit 127.0.0.1 host bindings resolved it. No LAN/public binding or public STUN service was introduced.

LiveKit's client is loaded only on voice connection. The production build currently emits a non-failing size advisory for its approximately 532 kB minified / 138 kB gzip lazy chunk. It does not add that SDK to the initial application bundle. Two existing deprecated Drizzle-tooling subdependencies remain; no production vulnerabilities were reported by the audit.

This is a single-process local voice MVP. Reservations are ephemeral; channels are persistent. Account checks run on each gateway handshake and in a one-second reconciliation sweep. Network/service failures may delay remote cleanup. No E2EE, private calls, ringing, push-to-talk, voice rename/archive UI, recording, streaming, signed installer, TURN/WAN setup or deployment is included. Edge/Electron on Windows 11 are verified; other browsers and physical devices require validation.

Use [README](../README.md) for exact startup, shutdown and test commands. Existing data, old migrations and Docker volumes are preserved. No push or deployment occurred.

## Development startup fix — 2026-10-25

The Windows development API watcher was observed remaining alive without opening port 3001, leaving the desktop command waiting indefinitely while Vite was ready. The launcher now uses Node's native watch mode with the existing tsx loader. A real subprocess regression runs that exact API command under concurrently, verifies HTTP health, touches an imported source file and verifies a successful restart.

The desktop readiness check now has a 30-second deadline, identifies unavailable services, and verifies the API response belongs to Tricord. Tests cover success, an unavailable API and an unrelated service on the API port. Existing normal/failing desktop-supervisor exit tests remain intact. The actual pnpm dev:desktop command was run: Vite and Fastify listened, readiness succeeded after starting PostgreSQL, and the real Tricord Electron window opened.

Four new startup regressions bring the suite to 104 tests (24 unit/regression and 80 database integration). The earlier production-build smoke tests did not cover this watch-mode startup path; the new regression closes that gap.

## Voice reliability and ten-client verification — 2026-10-25

The first capacity run reproduced an HTTP 429 while opening the eighth browser: static assets, channel polling and voice heartbeats consumed one shared IP budget. Static assets are now excluded from API counting, and voice endpoints have independent bounded 120/minute/IP quotas. Tests explicitly verify that API and heartbeat limits still reject excess requests.

Repeated runs also reproduced an intermittent publication race: all clients displayed Unmute as completed, but one server track stayed muted and the other clients received only eight streams. The SDK cannot signal a mute change before publication assigns the track SID. Tracks now publish muted, hold preference changes until publication completes, then apply the latest mute/deafen state.

Further regressions cover lease renewal during a retry without creating duplicate rooms, leaving during microphone acquisition/replacement, failed publication cleanup, obsolete microphone errors after rejoining or choosing another device, delayed output routing after leaving/rejoining, and device-enumeration rejection. Cleanup and error callbacks are fenced by room identity and join generation.

| Check                                  | Result                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| Unit/regression suite                  | 35 passing                                                           |
| Database integration suite             | 81 passing                                                           |
| Total Vitest tests                     | **116 passing**                                                      |
| Existing Edge authentication/messaging | 22 checks                                                            |
| Existing Electron                      | 23 checks across three launches                                      |
| Two-client voice                       | 17 checks with actual synthetic audio                                |
| Ten-client capacity/recovery           | 9 scenario checks; ten independent Edge processes                    |
| Static checks and builds               | Formatting, ESLint, TypeScript and production builds pass            |
| Infrastructure                         | Existing PostgreSQL healthy and LiveKit running; loopback ports only |

The capacity test uses approved disposable accounts, a temporary database, a unique LiveKit room prefix, synthetic microphones and production rate limits. It requires nine incoming audio streams, two active peer connections and one live microphone per connected client. A 65-second steady phase checks advancing audio counters, health responsiveness and reservation count. An eleventh account is rejected. All ten clients recover after simultaneous signaling loss and after an actual restart of the isolated API. A freed slot is reusable, and leaving closes all peer connections and captured microphones. HTTP 429 responses are forbidden throughout recovery as well as steady operation.

The harness removes only its own browser profiles, media rooms and database, and records cleanup failure as a failed run. It does not restart the shared LiveKit/PostgreSQL containers or change development accounts, applied migrations or volumes. Reports are ignored under artifacts/voice-load.json; failed runs also include diagnostics from the disposable clients.

These are local synthetic-audio results on one Windows 11 host, not a remote ten-person call or listening-quality certification. API memory includes the Node test harness and excludes browsers/Docker. Physical microphone/speaker quality, real USB/Bluetooth removal, long calls, WAN/TURN and hosting remain unverified. The existing approximately 532 kB lazy LiveKit chunk still produces a non-failing build-size advisory. No dependency, deployment, publication or push was added.

### Final recorded capacity run

| Measurement                                               | Observed result           |
| --------------------------------------------------------- | ------------------------- |
| Steady phase                                              | 65.3 seconds, ten clients |
| Maximum sampled API health response                       | 17.0 ms                   |
| Highest sampled event-loop p95 (20 ms monitor resolution) | 32.4 ms                   |
| Highest sampled Node API/test-process RSS                 | 230.1 MiB                 |
| Highest sampled inbound audio jitter                      | 2.0 ms                    |
| Cumulative received packets at end of steady phase        | 330794                    |
| Reported lost packets at end of steady phase              | 0                         |
| HTTP 429 responses, including recovery                    | 0                         |

All nine capacity/recovery checks passed, followed by successful test-resource cleanup. Expected HTTP 410 heartbeat responses after restarting the isolated API trigger fresh reservations; they are not failed authentication or throttling. These measurements describe this short local run and are not production service guarantees.

## Voice-test startup prerequisite fix — 2026-10-25

A user rerun failed with ECONNREFUSED at 127.0.0.1:5432 because Docker Desktop was stopped. The capacity command now performs a read-only PostgreSQL query and an authenticated LiveKit readiness call before building. Direct API invocation repeats the check before creating disposable fixtures. Missing services produce startup instructions without printing connection strings or raw driver errors.

The stopped-database path was reproduced with the actual root command: it exited before building and instructed the user to start Docker Desktop and run pnpm db:up. Docker Desktop and the existing Compose services were then started without replacing credentials or volumes. Five new regressions cover readiness, stopped PostgreSQL, stopped LiveKit, missing voice configuration and rejection of remote databases. They bring the suite to 121 tests (40 unit/regression and 81 database integration).

After startup, the exact root command pnpm test:voice:load passed its readiness checks, production build, all nine capacity/recovery scenarios and cleanup. All 40 unit/regression tests, lint, API TypeScript checking and repository formatting also passed. The existing LiveKit bundle-size advisory remains unrelated to service availability.

## GitHub and hosted-alpha preparation — 2026-10-25

All 127 Vitest tests pass (46 unit/regression, 81 database integration), along with formatting, lint, TypeScript and production builds. The existing Electron smoke still passes all 23 scenarios across three launches; the real two-browser voice smoke passes all 17 scenarios after adding hosted configuration.

A pinned multi-stage Linux server image was built and run as the non-root node user. Its isolated smoke verified migrations twice, web asset serving, PostgreSQL readiness, real registration/login with native password hashing, Secure/HttpOnly/SameSite cookies, pending-account restrictions, private Docker-network LiveKit room control, opaque hosted voice leases and an actual pg_dump/pg_restore round trip. The PostgreSQL fixture uses tmpfs; cleanup removes only test containers, their network and generated temporary files.

New configuration regressions enforce exact HTTPS desktop origins, preserve local/test origins, reject public LiveKit control hosts, require production voice credentials and allow server-supplied ICE/TURN configuration only for hosted leases. Temporary desktop-session cleanup now selects cookies only for its configured server.

GitHub Actions uses pinned official actions and read-only repository permissions. It runs the standard suites, production build, image build and backup/restore smoke without deploying. The initial history review covered all seven prior commits and 182 unique file blobs; configured secret values and sensitive-path/credential-pattern checks found no matches.

Cloud provisioning, DNS, trusted TLS termination, TURN/TLS, operational backup scheduling and cross-network voice testing still require a chosen server/domain and access. See hosting.md for the deployment boundary and remaining work. The existing LiveKit lazy-chunk advisory remains.

## Unread messages, mentions and desktop notifications — 2026-10-26

An additive Drizzle migration creates conversation_reads with one monotonic sequence cursor per account/conversation. The migration was applied to the existing development database and rerun successfully without removing any data or Docker volumes. Counts exclude own/deleted messages and enforce existing membership-history visibility; fetching history alone never advances read progress.

The UI adds unread and mention badges, an unread window-title count, complete case-insensitive @username matching and mention highlighting. Visible, focused reading at the latest messages advances the cursor. Reading older messages preserves scroll position and new unread messages until Jump to latest messages. Dialogs and mobile navigation prevent automatic acknowledgement. Socket delivery supplies authorized unread summaries for unselected conversations, and coalesced read acknowledgements use the same authenticated connection. Existing IP and socket request budgets remain unchanged. A regression exercises 100 read acknowledgements from ten accounts with production limits enabled, without HTTP conversation requests.

Notifications are opt-in per account/browser/device, cover private messages and mentions outside the focused conversation, and use generic previews without message text or participant names. Retries, edits and deletes do not create duplicate new-message alerts. The isolated Electron test verifies invalid IPC rejection, Windows development shortcut registration and a real native notification show event. Browser notification permission, generic body, click navigation and disabling are checked with only the OS notification adapter mocked. Notifications require the app/browser to remain open; no background push service is added. Multiple enabled devices may each alert.

Validation: 139 Vitest tests (51 unit/regression and 88 PostgreSQL integration), including cursor validation/monotonicity, cross-device synchronization, pre-join/absent membership privacy, suspension and recipient authorization. Formatting, ESLint, TypeScript and production builds pass. The expanded Edge smoke covers 30 authentication/messaging/unread/notification scenarios, including persistence after reload, controlled unfocused reading, notification navigation and reading history. Electron passes 26 scenarios across three launches; two-browser synthetic voice passes 17 scenarios. Visual inspection confirms badges and controls fit the existing desktop layout.

The production image and isolated backup/restore smoke are verified with the additive schema. Test accounts/databases and media resources remain disposable. No authentication, messaging or voice permissions are broadened; no dependencies, hosting deployment or GitHub push are introduced. The existing lazy LiveKit bundle-size advisory and legacy pnpm deploy warning remain non-failing. Physical microphone quality and remote ten-person voice remain outside this local verification.

## Repository agent guidance — 2026-10-26

Added root AGENTS.md, MEMORY.md and SKILLS.md, plus repository-local skills for verification, database work, voice and hosting. README links the entry points. Memory records dated evidence and unresolved work; it does not grant permissions or claim automatic persistent memory.

Three independent review passes completed:

1. Source and command accuracy: corrected call-microphone wording to preserve the user-triggered device-discovery probe, and documented the test role's CREATEDB prerequisite.
2. Instruction quality, discovery and privacy: no material findings; checked scope, relative references, fixture ownership, data preservation and approval boundaries.
3. Forward-testing against five scenarios: documentation-only work, refused PostgreSQL connections, hosting preparation, authorized publication and additive migrations. Added explicit review of all outgoing commits, including earlier unpushed work. The reviewer rechecked the correction and reported no remaining findings.

Validation: all four manifests pass the Skill Creator validator; 43 local links and 33 root-command references across the guidance and README resolve correctly. Repository formatting and git diff whitespace checks pass. The official validator's YAML dependency was installed only in a temporary tooling directory, with no project dependency changes. No runtime suites or local services were started for these documentation-only changes; the application results above remain separately dated evidence.

## Staging/production CI/CD preparation — 2026-10-26

Verified the local hosting-preparation changes on top of `cad4622`; no source push, image publication, GitHub environment change or server deployment was performed. Delivery remains disabled unless the repository variable HOSTING_ENABLED is explicitly set with configured staging/production environments and hosts.

The prepared pipeline keeps pull-request CI read-only, passes the exact tested image to a registry-write job, deploys staging by digest and promotes the same digest through the production environment approval. Policy regressions reject other repositories, mutable image tags, non-main or superseded commits, GitHub API failures and missing production reviewers/branch restrictions. Administrator bypass must be disabled in the GitHub UI; its REST property is checked only when the API exposes it. Current official artifact-action pins and input compatibility were checked against their upstream repositories.

Validation passed: **63 unit/regression tests and 88 PostgreSQL/LiveKit integration tests (151 total)**, ESLint, TypeScript, the Windows production build, Linux server-image build and existing isolated server-image/backup-restore smoke. The proxy regressions verify unchanged per-client quotas, ignored forwarding headers by default, exact immediate-peer trust when enabled, and rejection of malformed/chained addresses. Fastify's installed version rejects numeric hop-count trust; the implementation uses an explicit peer predicate and a fixed private frontend subnet instead. Initial integration startup found PostgreSQL stopped; starting the existing loopback database and LiveKit services resolved that prerequisite without resetting data or regenerating credentials.

The new hosted-stack smoke passed with the pinned production Compose services, a disposable self-signed certificate trusted explicitly by the fixture client, a random loopback HTTPS port and tmpfs PostgreSQL. It checks migrations, real HTTPS/web assets, proxy replacement of spoofed forwarding headers, Secure/HttpOnly/SameSite login cookies, private authenticated LiveKit control and a real internal TURN TLS handshake with IP-identity verification. All media host ports are removed from the fixture; no persistent database volume is created or deleted. Cleanup removes only its own project and temporary files.

An additional networkless container without a Docker socket executes the real deployment script against mocked Docker/restic/HTTPS commands. It verifies that backup failure blocks migrations, migration failure blocks app startup, failed HTTPS does not update successful-release markers, and only a complete successful run records the commit/image and current-release link. Mutable image tags and a mismatched environment fail closed. This verifies orchestration behavior, not a live off-server storage backend.

The workflow passes actionlint 1.7.12 and all operator scripts pass ShellCheck 0.11.0 with shared-source resolution; those validators are pinned by container digest in CI. Both changed repository skills pass the official Skill Creator validator. Its PyYAML dependency is confined to ignored local tooling, with no application dependency added. Formatting, local Markdown links and whitespace checks pass.

Not exercised: GitHub-hosted execution/publication, SSH or actual promotion, trusted public ACME issuance/renewal, systemd scheduling/alert delivery, a real off-server restic backup/restore, provider firewalls or voice across networks/physical headsets. TURN/TLS is prepared on 5349; networks requiring relay TLS on 443 need a separate tested arrangement. Existing LiveKit chunk-size and legacy pnpm-deploy advisories remain non-failing. Browser/Electron UI and ten-client load suites were not repeated because UI/device/recovery logic and quotas were unchanged.

## Production-only delivery direction — 2026-10-27

Following the user's preference to omit staging, removed the permanent staging deployment job and its required dependency. The prepared path is now CI verification, publication of that exact tested image, production-policy checks and the required production environment approval. The disposable CI service/image smokes remain in place; helper support for a possible future staging host is retained. Documentation and memory now reflect the user's existing AlphaVPS C4G server and Cloudflare-managed rajcord.com domain, while explicitly noting that the current IP-only certificate templates are not yet adapted for domain deployment.

Validation: actionlint 1.7.12 passes the revised workflow; all five focused release-policy tests pass; repository formatting, local Markdown links and whitespace checks pass; the changed hosting skill passes the official Skill Creator validator. This update changes workflow dependencies and guidance only, so application builds and runtime integration smokes were not repeated. The 151-test/build evidence above remains dated to the earlier hosting-preparation working tree.

The first strict key-only SSH probe reached host-key verification and stopped because no trusted host key was configured. No authenticated remote inspection or VPS modification occurred. A provider-console fingerprint and usable SSH key access remain prerequisites; no supplied password was written into repository files or commands. No GitHub settings, DNS records, publication or deployment changed.

## Verified VPS access and domain configuration — 2026-10-27

Matched the VPS's RSA host fingerprint to the provider-console output supplied by the user. After the user installed a dedicated administrator public key through noVNC, strict SSH key authentication succeeded. Private-key material and the trusted host-key file remain under ignored local operator storage; the private-key ACL was verified to allow only the operator Windows account. This administrator key is not a CI deployment credential.

Read-only host inspection confirmed Ubuntu 24.04.2 LTS, two CPUs, approximately 4 GB RAM, 1 GB swap and 35 GB free root filesystem space. Only SSH was listening, no systemd units were failed, and no reboot-required flag was present. Docker, Node, restic and UFW were absent; no nft/iptables management executable was found. The effective SSH configuration still permits root and password authentication. These observations do not establish that a provider firewall is configured or that the host has ten-person voice capacity. No packages, firewall rules or application services were changed by this inspection.

Updated initialization to validate optional lowercase web/TURN DNS names separately from the public IPv4 used for RTC. Runtime markers select domain SAN requests versus the existing short-lived IP certificate path. Local readiness checks validate the HTTPS hostname and TURN DNS/SNI or IP identity; CI requires an explicit DEPLOY_HTTPS_HOST independently of its SSH address. Existing initialized credentials are never overwritten. Domain tests reject URL/port/newline/configuration injection before any directory is created.

Validation: nine focused hosting/release-policy tests pass, ESLint passes, and actionlint/ShellCheck pass the changed workflow/scripts. The server image builds and its existing isolated auth/migration/backup-restore smoke passes. The hosted-stack smoke passes real domain HTTPS and TURN TLS with distinct SANs and SNI, secure login cookies, private LiveKit control and deployment failure checks. Operator fixtures additionally check ACME domain-versus-IP argument selection and correct domain health targets. Fixture containers mount only the hosting source directories, excluding local SSH material and runtime environment files.

The broader unit run passed 64 cases and had one connection-refused failure in the existing API development watch/reload test. All four development-startup cases passed when rerun in isolation without changing that test or application code; no cause was established beyond the observed transient reload failure. Earlier full integration/Windows UI evidence remains separately dated, and those suites were not repeated for these hosting-script changes. Formatting, local links and the changed hosting skill validate successfully.

Still unverified: Cloudflare DNS changes, actual public ACME issuance/renewal, installed production service configuration, external backups/alerts, GitHub publication/deployment and WAN voice. The VPS is not running the application. TURN/TLS still uses port 5349, retaining the restricted-network limitation described in deployment.md.

## Cloudflare scoped access and DNS — 2026-10-27

The user saved the Cloudflare token through the documented hidden Windows prompt into ignored DPAPI-encrypted local storage. Decrypted it only in the operator account for API calls without printing credentials or headers. Verification reported an active token and active rajcord.com zone. Inspected exact-name DNS listings for rajcord.com and turn.rajcord.com; both were empty, so there were no A/AAAA/CNAME/delegation conflicts or existing records to replace.

Created only the two authorized DNS-only A records pointing to the selected VPS, with TTL Auto. Saved an ignored snapshot of the pre-change A-record configuration. Readback through the Cloudflare API confirmed both settings; independent queries through 1.1.1.1 and 8.8.8.8 returned the intended IPv4 for both names (resolved TTL 300 seconds). No other DNS records, zone settings, GitHub configuration or VPS services changed. Token verification confirms usability for the zone, not an independent audit of every token permission chosen in the Cloudflare UI.

Formatting and whitespace checks pass for the documentation updates. No application runtime tests were needed for this DNS-only operation. Public HTTPS, production deployment and off-server backup setup remain pending; DNS resolution alone does not establish a working app or voice connection.

## VPS foundation and GitHub delivery safeguards — 2026-10-27

Prepared and applied reviewed Ubuntu 24.04 host helpers to the selected VPS. Installed Docker Engine 29.9.2/Compose 5.6.1 from Docker's official signed Ubuntu repository, restic 0.16.4 and host/security tools. Enabled UFW for SSH and the intended HTTP/media ports, plus an owned DOCKER-USER/TRICORD-INGRESS forwarding filter. Allowed flows return to Docker's own rules; matching original destination ports prevents an unexpected host mapping from bypassing the port policy. The filter is reapplied by Docker's systemd startup hook.

Real external firewall checks used one disposable HTTP container listening internally on 8080 and mapped to host ports 80, 5432 and 19091. Port 80 returned the fixture marker from outside; 5432 and 19091 could not connect from outside while the same fixture remained reachable locally. Repeated successfully after Docker restart and after the OS reboot, then removed each fixture. This proves the tested IPv4 TCP paths and persistence; it does not certify UDP/IPv6 or provider-level firewall settings. No database volume was used or removed.

Disabled SSH password/keyboard-interactive authentication while retaining root key access. Applied with a temporary rollback timer, then verified fresh key access after actual SSH reload and cancelled the timer. A pre-reload validation initially hit SIGPIPE from an early-exiting grep under pipefail; fixed by capturing the effective policy before checking it. The disposable SSH regression covers large policy output, invalid-config cleanup, preservation of an existing drop-in and refusing reload on mismatched policy. Configured a separate tricord-deploy account/key, verified release-directory access, its reviewed deployment-script sudo rule and rejection of an unrelated sudo command. This CI access remains effectively privileged because it can supply the deployment code.

Applied Ubuntu's configured security upgrades and completed a planned reboot to kernel 6.8.0-147-generic. A transient direct sshd validation immediately after package updates found its socket-activated runtime directory absent; fresh SSH activation recreated it, and both syntax and subsequent connections passed. Post-reboot checks verified fresh administrator and CI key logins, active Docker/UFW, the Docker filter jump, no reboot-required flag and no failed systemd units. Only SSH was listening after cleanup. Security-update timers are enabled; automatic reboots remain disabled. Final idle resources were approximately 33 GB free disk and 3.5 GB available RAM with 1 GB swap unused; no application-load capacity claim follows from those figures.

Generated independent production secrets on the VPS using the pinned Node container, with /etc/tricord/production owned by root at mode 700 and application/database/LiveKit files mode 600. These permissions survived reboot. Host Node installation was unnecessary; initialization refuses to overwrite an existing environment. No PostgreSQL service, app owner or user data was created. Noninteractive certificate/migration containers now disable stdin/TTY attachment, with a regression proving a piped operator script's following command is preserved.

Obtained a real Let's Encrypt certificate covering rajcord.com and turn.rajcord.com, valid through 2027-01-25 in Europe/Belgrade (2027-01-24 23:33:55 UTC). The HTTP-01 renewal rehearsal against the ACME test service succeeded without replacing the production chain. A temporary loopback-only TLS probe verified both names and the real private-key/certificate pair against the system CA store without insecure verification flags; all probe/bootstrap services were stopped/removed afterward. These checks do not establish a live HTTPS app endpoint or running release renewal/reload/health timers.

Created and read back the production GitHub environment with reviewer fakebane and exactly the main branch, separate CI SSH/verified-host secrets and non-secret deployment variables. HOSTING_ENABLED is explicitly false. Protected main with required PRs, an up-to-date verify check bound to the actual GitHub Actions app, administrator enforcement, blocked force pushes/deletion and resolved conversations. Required second-person PR approval count is zero for the sole maintainer; production environment approval remains separate. The environment's administrator-bypass setting still requires UI verification/disablement because its REST property is not exposed and no browser connection was available. No code commit/push, image publication or app deployment occurred.

Validation: the expanded local hosted-stack smoke passes deployment failure checks, piped-input preservation, SSH policy regressions and real fixture domain HTTPS/TURN TLS. ShellCheck, actionlint, ESLint, repository formatting, local-link/whitespace checks and the changed hosting-skill validator pass. Previously verified application-image evidence is reused because the new changes concern host/operator tooling; browser/Electron, database and voice load suites were not repeated.

Backup destination remains unresolved. The user declined usage-based billing and questioned the Google Drive proposal; no R2 bucket, Google OAuth setup, SFTP subscription or backup repository was created. Local VPS backups can help operational recovery but share the VPS/disk failure risk. The off-server pre-migration gate stays enabled pending the user's intended backup arrangement. Owner initialization, alerts, source publication, app rollout and real cross-network voice remain outstanding.

Follow-up preparation: added a Cloudflare R2 setup guide and placeholder-only restic environment with bucket-scoped access, private Standard storage, protected credential handoff and a storage/recovery acceptance sequence. Checked Cloudflare's current bucket/authentication documentation and restic repository guidance. Formatting, relative links and whitespace checks pass. No credentials, bucket, subscription, repository or persistent local backup was created; runtime scripts were unchanged and runtime tests were not repeated for this documentation-only addition.

## R2 encrypted repository verification — 2026-10-27

After the user confirmed R2 was already enabled, created rajcord-production-backups and the requested bucket-scoped Object Read & Write account key, and saved its S3 credentials using hidden prompts, read the existing rajcord.com zone's account ID to identify the matching default R2 endpoint. No DNS settings changed. Authenticated an S3 listing of that exact bucket and confirmed it was empty before initialization. This proves access to the chosen bucket; it is not an independent audit of the token's full scope or dashboard public-access settings.

Generated a separate random 256-bit restic password, saved an operator recovery copy protected by Windows DPAPI, and sent credentials/password only through verified SSH stdin. Installed root-owned mode-600 restic.env/restic-password on the VPS without overwriting existing files. Initialized the encrypted repository with host restic 0.16.4, uploaded a 32 KiB random disposable file, restored its exact snapshot into a private temporary directory, and compared the bytes. Removed only that probe snapshot by its exact ID; did not prune repository packs. A full restic check --read-data passed. Final readback through the real deployment common helper loaded the protected configuration successfully and confirmed zero remaining snapshots and zero app containers. No production database or snapshot exists yet; no database freshness/recovery marker was fabricated and maintenance timers remain disabled.

The optional encrypted runtime configuration/certificate recovery snapshot was blocked before execution by automatic approval review because it includes production secrets/TLS private keys without that specific export authorization. Explicit approval was requested; no such upload occurred. Database-backup authorization and storage-probe success do not establish approval for this separate sensitive payload. The planned snapshot excludes R2 keys and the restic password and uses a separate runtime tag to avoid database restore selection.

Corrected Windows line endings in the ignored upload wrapper after its first attempt failed before uploading the helper. Repository source changes in this step are documentation/reference-only; formatting, relative-link and whitespace checks pass. Full application/runtime suites were not repeated. At that point, actual database dump/upload/restore, configuration snapshot approval, app deployment and scheduled maintenance remained pending; the configuration approval and verification were subsequently completed below.

## Production configuration recovery snapshot — 2026-10-27

The user explicitly approved uploading the production app/database/LiveKit configuration and TLS certificates, including secrets and private keys, encrypted to the chosen R2 bucket. With the environment lock held, backed up /etc/tricord/production under host tricord-production and the separate tricord-runtime-production tag, excluding restic.env and restic-password. Retrieved the runtime snapshot into a root-private temporary directory; verified each included file's bytes and permissions, certificate symlink targets, and absence of both excluded credential files. The runtime snapshot tag does not match the database restore selector. A full restic check --read-data passed, the owned temporary directory was removed, and the command exited successfully. No app containers were started and no live database or configuration was overwritten.

Updated the recovery guide and durable project state; documentation formatting, relative links and whitespace checks pass. Database dump/recovery, source publication, the first app deployment and active maintenance timers remain outstanding. The earlier automatic-review block is resolved by the explicit approval and successful scoped execution above.

## Delivery publication preflight — 2026-10-27

Refreshed origin and confirmed there were no earlier unpushed commits ahead of main before preparing feat/production-delivery. Read back HOSTING_ENABLED=false and main's required-PR/strict verify/admin protections. GitHub's environment API now returned can_admins_bypass=true; updated production to false while preserving the maintainer reviewer and exact main-branch policy, and verified the disabled value with a separate readback. Release policy now rejects both enabled and missing bypass information; the missing-field regression is covered.

Current Windows checks pass: TypeScript, all 65 unit/regression tests, ESLint and formatting. This full unit rerun includes the startup cases that previously had one transient connection refusal. The pinned actionlint/ShellCheck validators and both changed skill manifests pass. The disposable hosted-stack smoke passes operator failure handling, SSH regressions, real fixture domain HTTPS/TURN TLS, secure cookies and private LiveKit control. Docker Desktop was started as a local prerequisite; no volumes were removed. The initial restricted compiler invocation could not spawn workers, and the initial Docker check found the engine stopped; checks succeeded after resolving those environment prerequisites. Prior image/build/database evidence remains separately dated above; CI must verify the outgoing commit on Linux. Delivery stays disabled, with no production app or registry image published by this preflight.

Published the reviewed changes through feat/production-delivery and PR #4. Initial Linux CI passed unit/database/build/image recovery checks but failed the hosted voice fixture. Added phase/exit/service-state diagnostics without raw configuration or cookies. They localized LiveKit restarting while HTTPS and login passed. Reproduced on the VPS with a disposable container, no published ports and synthetic configuration: runner-owned mode-600 files with root plus cap_drop ALL produced a configuration permission denial; running as the matching file owner stayed healthy. The hosted fixture now sets LiveKit's UID/GID to its configuration owner. Production remains root-owned mode 600 with the existing root container identity and unchanged capability restrictions. Temporary reproduction containers/files were removed. Windows hosted smoke is rerun for the fix; Linux CI must confirm it before merge.

## First-release image preparation — 2026-10-27

Both Linux verification runs for b344e0e passed all 65 unit and 88 database integration tests, production builds, image dump/restore and hosted HTTPS/TURN smokes. Refreshed the exact PR head/base and required checks, then squash-merged PR #4 as ca16b73 without bypassing main protection; fast-forwarded the clean Windows checkout. HOSTING_ENABLED remained false and no application/image publication was triggered by the merge.

Prepared a manual publish_only boolean workflow input, default false, for the first registry image. Trusted current-main publication can run with delivery disabled; both production policy and production deployment explicitly reject publish-only mode even if HOSTING_ENABLED is true. This closes the first-release ordering gap: initialize the private GHCR package and configure image access before enabling deployment. Normal PR/non-main jobs cannot publish. The pinned actionlint validator, formatting, changed relative links and hosting skill manifest pass. Runtime source/scripts were unchanged by this workflow/documentation addition; real CI and the first publish-only dispatch must verify the path before calling registry preparation complete.

## CI/CD adapted to this checkout — 2026-10-30

Prepared from clean baseline `613b367` in `C:\Users\Marko1\rajcord-public`; origin is `Treca-Raja/rajcord-public`. Publication, policy checks and server image validation now target lowercase `ghcr.io/treca-raja/rajcord-public` digests. Regression coverage rejects the predecessor repository and its image. No GitHub settings, registry packages, production credentials or services were changed, and no commit or push was performed.

The workflow adds headless Edge browser coverage on Linux and a parallel Windows typecheck/unit/build job. The aggregate required `verify` check accepts only success from both jobs before publication. Image transfer remains the exact tested artifact; production still requires current main, explicit protection checks, environment approval, strict SSH host identity and an off-server backup before migration. Workflow summaries report verification results, published commit/digest and successful deployment readiness. Prettier now accepts native checkout line endings without rewriting existing source or applied migration metadata.

Completed locally on Windows with Node `26.13.0` (declared minimum is 24) and pnpm `11.25.0`; GitHub jobs remain configured for Node 24:

- Frozen-lockfile install, formatting, ESLint, TypeScript and all workspace builds passed.
- All **66 unit/regression tests across 17 files** passed, including six release-policy tests. The first sandboxed run passed 62 tests but four development-process tests timed out or failed process cleanup; rerunning the suite outside the sandbox passed all 66 without code changes or test exclusions.
- Actionlint `1.7.12` with ShellCheck `0.11.0` passed the workflow; ShellCheck passed all hosting shell scripts. The actionlint download matched the official release checksum. Bash syntax, direct immutable-image allowlist checks and `git diff --check` passed.
- The existing non-failing LiveKit client bundle-size advisory remains.

Docker is not installed/available in this checkout's environment. Database integration, Linux browser smoke, server-image build/dump/restore and hosted-stack/operator-container smokes were not run locally. The new GitHub-hosted jobs, registry publication, repository environment/protection settings and deployment remain unverified remotely. Windows CI builds Electron code but does not launch its GUI or certify native notifications, physical devices or WAN voice. Those limitations are separate from the completed static, unit and local build checks.

## Linux CI browser startup fix — 2026-10-31

PR #22 at `33489b7` reported four failed checks across its push and pull-request workflow runs: Linux integration/image checks and their aggregate `verify` gate failed in each run; both Windows jobs passed. The supplied browser-step trace shows Edge never published `DevToolsActivePort`. Browser stderr had been discarded, so the trace does not establish the exact startup cause.

Changed only the Linux CI browser selection to installed Google Chrome stable, whose standard binary has an Ubuntu AppArmor allowance. No `--no-sandbox` flag or host-security change was introduced; local Windows browser tests still default to Edge. A test-harness readiness helper now reports safe launch-error codes, early exits/signals or bounded port timeouts instead of asserting against an empty string. It keeps at most 8 KiB of startup stderr for classification, removes its listeners after startup and never logs raw browser output or profile paths. Nine focused tests cover port discovery, retry, missing executable, exit, signal, invalid ports/timeouts and sanitized failure messages. The browser smoke and combined release gate remain required.

Local Windows verification with Node `26.13.0` and pnpm `11.25.0`: all **75 unit/regression tests across 18 files**, formatting, ESLint, TypeScript, workspace builds and Actionlint/ShellCheck validation passed. A real sandboxed Windows Edge process launched with an isolated temporary profile, published CDP, answered the debugging endpoint and closed cleanly through `Browser.close`; its specifically owned profile was removed. This startup probe needs no database and does not claim the full browser/auth/chat smoke passed locally. Docker remains unavailable, so the full Linux CI browser/container suites require a fresh GitHub run. No production settings or services were changed.

### Approval recovery found during the Linux rerun

After `a9d4f8b`, the push workflow passed Linux browser/integration/image checks, Windows checks and aggregate verification. The concurrent PR workflow got past browser startup but timed out waiting for approved UI after registration. AuthRoot refreshed on live account events but not socket connection, so approval emitted before room subscription could be missed until the existing 60-second timer.

Added one coalesced authenticated state refresh on socket connection using the existing generation guards. The browser regression uses a smoke-only Socket.IO middleware gate to reject handshakes with the existing retryable error, approves a pending account while no socket is subscribed, then opens the gate and requires the approved UI to recover without reload, focus, manual status checks or a longer timeout. Existing permission checks, rate limits and realtime approval/suspension scenarios remain; browser coverage is now 12 authentication plus 19 messaging/unread/notification checks (31 total). The nine startup unit tests and all 75 unit/regression tests remain part of CI. A new GitHub run is required to verify the full browser/database regression because Docker is unavailable locally.
