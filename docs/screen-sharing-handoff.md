# Screen-sharing contributor and GPT handoff

Updated 2026-11-13. Screen sharing is implemented locally on `feature/screen-sharing-completion`, continuing the pushed `feature/screen-share-design` checkpoint. It is not a production deployment, signed release, or physical/WAN performance qualification. This document supersedes the old slice-1 continuation prompt; dated evidence remains in [verification.md](verification.md).

## Current continuation - 2026-11-13

The source branch was `a30525f`; fetched `develop` was `05bb0ca`. Both remote tips were rechecked unchanged during completion. The original 69 completion files (51 tracked modifications plus 18 new files) and staged upstream integration were snapshotted before continuation. The integration includes current `origin/develop` at `05bb0ca`. The user has now authorized a feature-branch commit/push and PR to `develop` after validation. Shared-branch merge, deployment and desktop rollout remain separately gated.

The user's current requirements are internet P2P, independently selectable resolution and frame rate, separate video bitrate, and sharing in the main window. The initial choices are 480p/720p/1080p, 15/30/60 fps and 2/4/6/8/12/20 Mb/s per viewer. These are ceilings, not measured delivery. Ultra/4K remains deferred.

The dedicated screen policy keeps Cloudflare STUN and prefers direct ICE. Optional `SCREEN_TURN_HOST=turn.rajcord.com` reuses the pinned LiveKit 1.13.10 TURN service on its existing UDP 3478/TLS 5349 listeners. The API issues separate 60-second TURN allocation credentials after exact screen-binding authorization and refreshes them on renewal; no LiveKit room JWT/API secret enters the renderer. Credentials stay in memory. The setting is off until explicitly configured. Existing LiveKit relay destination/quota policy still applies; forced relay media, especially two peers using the same VPS relay, remains a manual acceptance gate. No additional VPS service/port is proposed.

## Implemented composition

- `VoiceController.bindScreens` privately delegates the exact current lease. Copied/frozen replies, request-start deadlines, lease/generation fences and retained raw bind/retirement admission prevent stale adoption. No lease/Room/JWT getter or binding control enters VoiceControls.
- One bootstrap-owned `ScreenRuntime` retains the capture adapter, incoming lane and binding admission across React StrictMode, session/provider replacement and suspension. A failed optional screen owner does not prevent microphone voice.
- One dedicated cookie/CSRF-authenticated screen socket belongs to the approved session/exact binding. It does not reconnect or share AuthRoot's chat socket. Screen protocol 2 rejects older versions explicitly.
- C1 capture preparation requires the same session, exact lease and connected S1 binding. Main derives native frame/navigation identity and independently authenticates Session.fetch with HttpOnly cookies. Renderer correlation tags and epochs confer no authority.
- C2 publish returns a finite `{share, remainingMs}` proof; renew asserts the exact live own publication. Main promotes consumed preview authority into a distinct publication record and checks it independently. Replays retain absolute deadlines; voice heartbeats alone cannot revive publication.
- CaptureSession atomically changes preview supervision to publication while retaining the adapter/result/tracks. Explicit branded renewal is adopted by binding, source, peer, incoming and playback owners before the old deadline. Source/session/lease loss remains a root stop; old preview callbacks cannot stop a promoted source.
- The actual main-window UI supports preparation, fresh-gesture source choice, silent local preview, explicit Start, independent outgoing and watching quality, source-sound consent, watching, screen mute/volume, exact selected output, hide/resume and reachable Stop. Publisher video ceilings are installed before an offer and confirmed after negotiation. At zero viewers there is no outgoing screen peer/RTP.
- Source sound is video-only by default. Edge selected-tab sound and Windows desktop system loopback require explicit selection; system sound is labelled as potentially including every application. Source-sound failure never silently becomes video-only. These consent paths do not certify physical routing, intelligibility, feedback isolation or sync.
- Browser video-only capture may omit `displaySurface`, as Firefox does. The local capture then records an unknown surface instead of inventing a tab/window/monitor classification. It still requires the browser picker, exactly one live video track and no audio. Tab/system sound and desktop capture retain their verified source-type checks.
- Hiding/minimizing closes incoming delivery and conditionally unselects its exact old revision. Duplicate native/document visibility notifications preserve the saved watch selection. Returning waits for that cleanup, then selects afresh with the same viewer limits only if source/binding identity is still current and watching has not been stopped. Outgoing sharing continues. Screen Stop is available in the sidebar/panel and native menu/tray.
- Application sounds observe synchronous immutable call transitions so React batching and panel remount do not lose join/leave cues. Screen failures do not disconnect microphone voice.

## Stop limitation and acceptance gaps

The user explicitly chose the main-window architecture after the independent-stop tradeoff was explained. Accepted capture and peers remain call-renderer-owned. Main can invalidate pending/native authority and notify Stop; that alone does not prove cessation if this renderer is frozen or suspended. Do not silently destroy the shared voice window as a screen-only fallback or claim an independent hard cutoff.

Remaining manual qualification covers real picker/source identity, Windows system/Edge tab sound, physical output routing and digital feedback, normal autoplay/permissions, A/V sync, sustained rendered 1080p60, approved hardware/resource budgets, active voice plus fan-out, actual hidden-window packet cessation and consented cross-network/STUN behavior. Synthetic media, fake devices, native parameter readback and loopback peers do not close those gates. No signed-install/update acceptance is claimed.

## Reproduce relevant checks

Use Node 24+ and pnpm 11.25.0. Preserve existing credentials, schemas and volumes. Restore dependencies only if missing; build shared packages before source fixtures. Runtime suites require the documented loopback PostgreSQL/LiveKit services and disposable test data/profiles.

```powershell
pnpm exec vitest run --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm build
pnpm test:db
pnpm exec vitest run --config vitest.browser.config.ts
pnpm --filter @tricord/api test:browser
pnpm --filter @tricord/api test:voice
pnpm --filter @tricord/api test:voice:load
pnpm --filter @tricord/api test:desktop
pnpm test:desktop:capture
pnpm test:desktop:authority
pnpm desktop:package
pnpm desktop:audit
```

The actual app screen fixture uses port 3012, two or four disposable accounts, generated canvas video/PCM source sound and fake voice devices. It verifies preview consent, independent quality, direct candidate types, source/audio delivery, live viewer FPS changes, renewal beyond the original deadline, hide/resume limits and Stop preserving voice. It does not capture a private desktop or certify physical playback. The three-viewer case verifies independently received video and cleanup for all viewers while one hides/resumes. Use `pnpm exec vitest run --config vitest.browser.config.ts apps/web/src/screen-call.browser.integration.test.ts` after building to select it.

Inspect current source and [latest verification](verification.md#screen-sharing-continuation-and-production-restore-verification---2026-11-13) before continuing. The remaining work is acceptance/review and the normal separately authorized delivery flow; do not restart the old architecture investigation or implement a duplicate lease delegate/runtime. Follow AGENTS.md, preserve existing work, and keep local/synthetic, native-fixture, physical and WAN evidence distinct.

## Manual acceptance and production promotion

Do not mark these gates passed from synthetic fixtures:

- Use matched API/web/Windows desktop candidates with two different home networks, then one publisher and three viewers. Check real received video at each supported resolution/FPS, changing watching limits, readable motion/text, upload, CPU/GPU, temperature and voice continuity. Record achieved values rather than requested settings.
- Test actual monitor/window capture in Electron and supported browser tab/window/screen capture. Cancel the chooser, deny permission, close the selected source, Stop during preview/start/active sharing, switch voice channels, disconnect/reconnect, logout and revoke a session. Verify all old tracks/peers end and replacement sharing needs consent.
- Test video-only, Edge selected-tab sound, Windows whole-system loopback, missing requested audio, selected speaker disappearance, normal autoplay prompts, mute/volume/deafen, A/V sync and digital feedback from voice playback. Unsupported combinations must fail clearly without substituting microphone/default devices.
- After approved TURN configuration, verify real selected candidate-pair stats: direct first; relay under blocked direct UDP; TLS 5349 where UDP is unavailable; both peers on restrictive networks. Check two peers needing the same VPS relay against LiveKit's destination/quota rules. No TURN/TLS-on-443 compatibility is claimed.
- Hide/minimize and inspect actual network delivery cessation for incoming media, then authorized resume. Keep outgoing Stop visible. Test renderer unresponsiveness separately; independent hard Stop remains outside the accepted main-window architecture.
- Attempt viewing from a different voice channel, unapproved account, revoked session and stale selection. Confirm denied signaling/no new media. Viewers can record received content; P2P exposes peer IPs; the app/signaling server remains trusted.

The user-approved isolated production restore verification completed on 2026-11-13: latest encrypted off-server backup restored/schema checked using temporary corrected operator files and network-none/tmpfs PostgreSQL. Existing health checks passed; all four live container identities/start times/restart counts were unchanged. Only the successful restore timestamp changed and temporary fixtures were removed. The installed release's old restore script was not overwritten; the permanent TCP-readiness fix is part of this reviewed change and must reach scheduled operations through an approved release/maintenance action.

Before production: pass required feature PR CI/review, merge to develop only when separately authorized, prepare a develop-to-main release PR, verify the tested immutable image and rollback compatibility, refresh backup/restore evidence, approve deployment, deploy the matched API/web image, and perform the checklist with a small test group. Desktop distribution/update rollout requires explicit approval.
