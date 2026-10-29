# Rajcord Windows distribution

Rajcord uses the existing Electron client and the shared hosted React UI. Windows x64 installers are built with pinned electron-builder 26.18.0; electron-updater 6.8.11 handles signed NSIS updates. Electron remains pinned to 45.0.0. The updater's YAML parser has a scoped override to patched `js-yaml` 4.3.2, also used directly to validate its packaged trust configuration. This work does not deploy the web/API or change production infrastructure.

## Build locally

Use Windows, Node 24 and pnpm 11.25.0 from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm setup:desktop
pnpm desktop:package
pnpm desktop:audit
```

The default build is unsigned and has **no automatic update feed**. Output is ignored under `artifacts/desktop/`: `Rajcord-Setup-0.1.0-x64.exe`, its blockmap and `win-unpacked/Rajcord.exe`. The version in `apps/desktop/package.json` controls the executable metadata, installer name, preload version and release tag (`v0.1.0` initially). Increase that desktop version in a reviewed change for every release; other workspace packages need not change versions. Never replace an existing version's assets.

The identity is `com.rajcord.desktop`, product/executable/shortcut name `Rajcord`, and installer name `Rajcord-Setup-${version}-${arch}.exe`. NSIS installs per user, without elevation, with a selectable directory and Desktop/Start Menu shortcuts. Application data is stored in `%APPDATA%\Rajcord`, separately from the development `.local` profile. Uninstall preserves application data; revoke remembered devices from Settings when retiring a machine. Development profiles are not migrated automatically.

The original geometric R icon is tracked as SVG, PNG and multi-resolution ICO. Regenerate it with `node scripts/desktop-icons.mjs`; no image service or extra build dependency is needed.

Never copy `.env`, `.local`, profiles, server code, API keys or signing material into the app. The desktop archive includes compiled desktop runtime code, its icon and production npm dependencies. `pnpm desktop:audit` checks identity, excluded private/test files and update configuration. The installer uses the system's normal HTTPS trust; there is no TLS-error bypass.

## Runtime behavior

- Packaged clients always load `https://rajcord.com`; inherited `TRICORD_DEV_URL`, `TRICORD_SERVER_URL`, test profiles and smoke flags cannot redirect them. The development commands retain their existing local behavior.
- Closing a packaged window hides it to the tray and keeps voice connected. Double-click the tray or choose **Show Rajcord** to restore it. **Quit Rajcord** or Ctrl+Q exits and disconnects voice. If tray creation fails, closing the window quits. Development and smoke windows still quit on close. Restarting an already running app restores its window.
- Native menus provide clipboard/zoom commands, update checks and explicit installation of a downloaded update. Unrequested external links, new windows, renderer navigation, cross-origin redirects and webviews are blocked.
- Notifications retain per-account opt-in, generic previews and click-to-open behavior. They require the app to be running, including in the tray. The installer registers the same AppUserModelID used by notifications. No login autostart is enabled.
- Context isolation, sandboxing, disabled renderer Node integration, main-frame/origin checks and narrowly scoped notification IPC remain enabled. Updates are controlled by native menus/dialogs, without privileged updater IPC exposed to hosted content.
- Voice continues through the same authenticated `/media/rtc` gateway. Usable LiveKit tokens stay server-side. Microphone-only consent and exact input/output selection are unchanged; camera and screen capture stay denied. Hiding to tray does not tear down media. Updates require confirmation because restart disconnects calls.

## Signing and automatic updates

An unsigned first release can be installed and replaced manually. Windows may identify it as an unknown publisher; **do not disable SmartScreen, antivirus, certificate validation or update verification**. Review the source/release provenance before distributing it. An unsigned installation cannot bootstrap automatic updates: users must manually install the first signed version.

For updates, obtain a Windows-trusted Authenticode signing certificate/service and protect its private key. No certificate has been purchased or configured by this change. The included workflow supports a PFX certificate accepted by electron-builder; HSM/cloud signing requires a separately reviewed signing integration. Use an isolated signing account and retain protected recovery material.

Configure these only in the protected GitHub `desktop-release` environment:

| Name                   | Kind     | Purpose                                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- |
| `WIN_CSC_LINK`         | Secret   | Base64 PFX certificate, or a supported private certificate location                |
| `WIN_CSC_KEY_PASSWORD` | Secret   | Certificate password                                                               |
| `RAJCORD_PUBLISHER_DN` | Variable | Exact full `SignerCertificate.Subject` returned by Windows, including its ordering |

For a local signed build, supply those variables through your private secret tooling, set `RAJCORD_SIGNED_RELEASE=1`, then run the same package/audit commands. Never paste private values into documentation, shell history or tracked configuration. Use a clean generated output directory when switching build modes; the audit deliberately refuses stale unsigned/signed metadata combinations. `forceCodeSigning` makes a requested signed build fail without a usable certificate. Keep SHA-256 timestamped signing enabled through electron-builder defaults and verify both app and installer with Windows `Get-AuthenticodeSignature` before distribution.

Signed builds embed a fixed public GitHub repository (`Treca-Raja/rajcord-public`) and the publisher identity in `app-update.yml`. Checks run 30 seconds after startup, every six hours and from the native menu. Only stable releases are selected, with downgrades disabled. Download and restart each require user consent; quitting normally never installs an update. Drafts are invisible to the public update feed.

If session preparation fails, Rajcord reports the failure and keeps the verified download available for retry. Installer launch failures reported before shutdown also show feedback, cancel that attempt's queued quit and allow a fresh update check that revalidates the cached download. Normal user Quit remains unchanged. This uses the pinned updater's public installation API; preserve its installation flags and native update event when upgrading. Errors reported only after the process has exited still require the signed Windows acceptance checks below.

The installed stable updater checks artifact hashes against GitHub's HTTPS update metadata. Rajcord additionally uses its supported custom Windows signature verifier: Windows must report a valid **embedded** Authenticode signature for the exact file and exact trusted certificate subject. Missing publisher configuration disables the updater; unavailable PowerShell, timeout, malformed output, catalog signatures, unsigned files and different publishers block installation. Cached downloads are verified after retrieval and again immediately before installation. No GitHub token or privileged server credential ships with the client.

Version-specific sources: [v26 Windows verification API](https://www.electron.build/v26/docs/win/), [v26 auto-update guide](https://www.electron.build/v26/docs/features/auto-update/), and installed `electron-updater/out/NsisUpdater.js` / `windowsExecutableCodeSignatureVerifier.js`. The custom verifier closes the installed v6 verifier's PowerShell-unavailable fallback. The v27/v7 signed-manifest and verification behavior described on the unversioned website is **not** implemented by these stable versions. Metadata is protected by GitHub HTTPS and repository permissions; Authenticode authenticates the installer. Reassess those APIs/security requirements before upgrading either dependency. Certificate rotation requires a reviewed bridge release trusting the new exact subject while clients still trust the old signer; never disable verification to rotate.

## Authorized release process

`.github/workflows/desktop.yml` builds unsigned review artifacts on PRs, pushes to `develop`/`main`, and manual runs. Feature work follows `feature/*` → `develop` → `main`; desktop release publication remains restricted to explicitly authorized dispatches on `main`. Those review artifacts have a seven-day retention and are not published Releases. The existing Linux Verify workflow still owns the database/server checks. The new workflow does not deploy production.

Before the first release, an authorized repository administrator must create `desktop-release` with a required maintainer reviewer, administrator bypass disabled, and a selected-branch policy allowing exactly `main`. The workflow checks those settings before entering the environment and again after approval. This change does not create or modify remote environments or secrets.

The current source repository is `Treca-Raja/rajcord-public`, verified through GitHub on 2026-10-29 after the repository rename. Desktop update/release configuration uses that canonical repository. Separate local server CI source-identity edits require their own reviewed publication. Server image publication and image validators deliberately retain `ghcr.io/fakebane/tricord-public` pending verification of registry ownership and access after the transfer. Desktop releases still require the exact main commit's full Verify workflow to pass. Do not bypass either policy or approve a production deployment merely to satisfy this prerequisite.

1. Review the complete outgoing changes, update the desktop version and merge the feature PR into `develop` only with authorization. Promote the reviewed integration through a separately authorized `develop` → `main` PR. Wait for the exact main commit's full **Verify** run to pass.
2. Obtain explicit authorization for the concrete commit, version, signing mode and draft asset upload. Manually dispatch **Windows desktop** on `main` with `publish_draft=true`, `release_tag=v<desktop version>` and the chosen `signed` flag. Environment approval protects signing credentials and release-writing access. Branch/tag pushes alone never publish release assets.
3. The workflow builds/audits and creates a **new draft only**, including the NSIS `.exe`, `.exe.blockmap` and, for signed builds, `latest.yml`. It targets the exact approved commit and fails instead of replacing an existing release. Review the resulting files, signatures and checksums. Unsigned drafts contain no `latest.yml`.
4. Complete the acceptance checklist below. Obtain separate explicit authorization to make the reviewed draft public. Only then publish it from GitHub's release UI (or an explicitly authorized `gh release edit v<version> --draft=false`). Publishing the draft activates it for eligible installed clients. This workflow never makes that final transition automatically.
5. Keep all previous installers/blockmaps needed by older clients. Do not enable prereleases or overwrite `latest.yml` by hand. Roll back by fixing forward with a higher version; old clients reject automatic downgrades.

No release, push, merge, environment configuration, signing purchase or infrastructure change is authorized by this runbook itself.

## Acceptance and Windows checks

Run the repository quality/runtime commands in [verification](verification.md). For install testing on a Windows account with **no existing Rajcord installation, shortcuts or personal profile**, build first, then run:

```powershell
pnpm desktop:test:install
```

The fixture refuses to replace an existing installation or personal profile. It silently installs into `.local/desktop-install`, checks executable metadata and shortcut targets, launches the installed app with loopback DevTools automation, verifies the anonymous production sign-in page, preload version, isolation and secure WebRTC/media APIs, then terminates only that test process and uninstalls. It never signs in or opens a microphone. It checks shortcut/registration removal and profile preservation. Native tray/Quit behavior remains a manual check; CDP key events do not exercise native menu accelerators. The resulting `%APPDATA%\Rajcord` test profile is intentionally retained with a fixture-ownership marker; subsequent runs can reuse that fixture profile. Do not use the fixture profile for personal accounts. The test command uses a process-scoped PowerShell RemoteSigned policy and a debugging flag; ordinary shortcuts do not enable debugging.

Manual release gates (record versions, OS, signing mode and actual results in `docs/verification.md`):

- Run the interactive installer/uninstaller on Windows 11 as a standard user; check directory selection, icons, Apps & Features identity/version, shortcut AppUserModelID and absence of unnecessary UAC. Confirm uninstall preserves user data. Observe SmartScreen behavior for the chosen signing mode.
- Test tray close/restore, minimize, second launch, Ctrl+Q, OS shutdown and offline startup. Confirm voice stays connected while hidden and disconnects on Quit. Test session revocation/remembered sessions across installed restarts.
- With two authorized accounts, test sending/editing/deleting text, DMs/groups, unread state and generic opt-in toasts, including click restoration from tray. No participant names or message content may appear in OS previews.
- In the installed build, test physical microphone consent and exact microphone/speaker selection, mute/deafen, unplug/reconnect, suspension/resume and two-person listening over separate networks. Check TURN fallback. Repeat the community capacity gate when required; synthetic local media alone is insufficient.
- With explicit authorization for **two signed test releases** from an isolated test repository and a reviewed test build pinned to that repository, install version A, publish the higher version B with the same trusted publisher and valid metadata, check detection, decline/download/restart, then verify B's installed version, preserved session, messaging and voice. Never upload experimental `latest.yml` to the production feed. The production build's repository is pinned; testing another feed requires a reviewed fixture configuration/build, not a runtime override.
- Negative update tests: corrupted artifact/checksum, unsigned installer, wrong publisher, unavailable/blocked PowerShell, offline check/download and cached-file tampering must block installation. Quit while a verified update is pending must not install it. Declining restart must leave the call connected. Verify recovery by retrying a valid release.

Two published test releases, real certificate signing and physical/WAN acceptance require the corresponding credentials, devices and task-scoped approvals. Unit tests and an unsigned installer build do not establish those results.
