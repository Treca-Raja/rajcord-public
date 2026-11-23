# Screen-sharing contributor and GPT handoff

## Windows OBS publisher

**Share Your Screen** uses OBS automatically on Windows desktop. Join voice, select quality and sound, then prepare, choose a source, review the silent preview and start the share. Automatic encoder selection prioritizes the GPU associated with the source display. The supported encoders are NVIDIA NVENC, AMD AMF and software x264. An unavailable helper or encoder produces an actionable preparation error. Old clients need the OBS-capable desktop bridge to publish.

The main process verifies the exact picker selection and starts a supervised helper. OBS captures the authorized window or display with Windows Graphics Capture, composites on Direct3D11 and encodes H.264 for each authorized peer. A minimized or hidden window produces blank video until it returns. The helper retains the selected window identity across focus changes and resizing and ends the share if capture is lost. The minimum capture interval applies on supported Windows builds, including after capture-session rebuild. The private WASAPI, Opus and WebRTC transport libraries support the OBS helper. They retain exact process-scoped audio, independent viewer authorizations, P2P ICE and congestion control. The desktop picker uses Windows Graphics Capture for game windows. The source rebuild also supports an explicit Game Capture trial with an owned game window. The isolated Electron picker has a local preview. Normal browsers retain browser-native publishing and can receive OBS streams. [OBS output and encoder API](https://docs.obsproject.com/reference-outputs) · [Windows capture update interval](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval?view=winrt-26100)

Viewers choose a stream and its playback controls. Every outgoing link uses the broadcaster's current quality ceiling and adapts independently to delivery conditions. Focus and grid changes are local layout actions. **Apply stream quality** updates the authorized publication and its active peers. The selection endpoint accepts older clients' quality fields for protocol compatibility and sends the broadcaster's ceiling in the existing link response fields.

### Build and package the Windows sender

Use Windows x64, PowerShell 7, Git, CMake, Visual Studio x64 C++ tools with MSVC v143 14.44 and the x64 Visual C++ v14 redistributable, and Windows SDK 26100. Use a CMake release that supports the installed Visual Studio generator.

```powershell
pnpm desktop:obs:setup
pnpm dev:desktop
pnpm desktop:package
pnpm desktop:audit
python scripts/audit-obs-runtime.py artifacts/desktop/win-unpacked/resources/obs-screen
```

Setup builds the headless OBS runtime from commit `0c790bd0151fb9f574867e025ecf57e6eedc58e2` with SHA-256-checked OBS dependency archives dated 2026-10-23. The x86 archive supports the capture hook and helper for 32-bit games. The helper checks the libobs build string at startup. Setup also builds libdatachannel at `4e4f4892dccb2a57fe3a490d0c9d958de4244e74` and its pinned submodules, with vcpkg source recipes for libnice, GLib, OpenSSL and Opus. The vcpkg tool is hash-pinned and the runtime uses Windows x64 release libraries. [OBS source revision](https://github.com/obsproject/obs-studio/commit/0c790bd0151fb9f574867e025ecf57e6eedc58e2) · [OBS dependency release](https://github.com/obsproject/obs-deps/releases/tag/2026-10-23)

Source builds use `.local/obs-native-build` and downloads use `.local/obs-sdk/native`. Setup stages the app-local bundle at `apps/desktop/native/obs/dist/bundle`. For preverified inputs, call `setup.ps1` with `-SourceArchive`, `-X64Dependencies`, `-X86Dependencies` and `-CodecHeaders`. `-DownloadDirectory` reuses the verified archive cache. `-VcpkgSource` and `-RtcSource` accept local checkouts at the pinned commits. The separate `-BuildDirectory` contains the compilation outputs. The installer carries the native runtime under its resources directory. Packaging and audit require source provenance and the native transport. See [runtime notices](../apps/desktop/native/obs/runtime-notices.md) for the private distribution boundary.

To compare game capture providers, set `SDL_RENDER_DRIVER=direct3d11` and use the owned Freedoom fixture with `RAJCORD_OBS_GAME_CAPTURE_TEST=1` for the OBS hook. Clear that fixture flag for WGC. Game Capture validates the selected window, thread and process, then verifies the captured window before rendering. It loads its hook and compatibility data from the bundle. The picker's normal application path uses WGC. [Game capture evidence](verification.md#obs-source-rebuild-and-game-capture--2026-11-22)

### Native media and congestion

Each authorized viewer has an OBS H.264 encoder, a libdatachannel peer, an independent feedback controller and a bounded video queue. libnice provides ICE and TURN. Publisher TURN/TLS uses the certificate-verified desktop tunnel. Native libopus encodes 48 kHz stereo WASAPI PCM in 20 ms packets. Both media streams use the Windows capture clock.

The video controller uses RTCP receiver reports, RTT and recurring repairs to adjust bitrate. When loss or queue pressure persists, it can move from the selected format to at most 720p30 or 480p30. Hysteresis limits encoder restarts. The sender restores the broadcaster's format on the same connection as the path recovers. The pacer budgets repairs alongside video, discards stale video and allows Opus and RTCP to bypass the video queue. Audio and voice still compete for bandwidth on a shared link. `RAJCORD_SCREEN_BENCH_DIAGNOSTICS=1` records capture and encode cadence, feedback, repairs and queue age. [Verification evidence](verification.md)

### Local tests

Run `pnpm build` before the following fixtures.

- With disposable loopback PostgreSQL and LiveKit, run `node --env-file=apps/api/.env apps/api/dist/screen/obs-app-smoke.js` for signed-in Electron picker, playback, live publisher-quality changes, viewer leave/rejoin and Stop. Add `--edge-viewer` for browser playback. Use separate runs with `--end-source`, `--crash-helper`, `--logout` or `--revoke` to verify termination. Add `--voice-room` with `RAJCORD_SCREEN_BENCH_VIDEO` pointing at a local gameplay recording for the ten-person synthetic voice case.
- Run `node scripts/test-obs-screen.mjs` for one, two and three visible Electron viewers. Set `RAJCORD_SCREEN_BENCH_BUNDLE` to exercise an unpacked installer runtime. For an owned window lifecycle test, set `RAJCORD_SCREEN_BENCH_VIEWERS=1` and `RAJCORD_SCREEN_BENCH_WINDOW_LIFECYCLE=1`. For a shaped UDP path, use `RAJCORD_SCREEN_BENCH_IMPAIRMENT=1` in a separate run. The local coturn video check uses `pwsh -NoProfile -File scripts/test-screen-coturn.ps1 -VideoOnly -Long` to exercise UDP, TCP and native publisher TLS, plus credential renewal on rejoin. For coturn with H.264 and Opus, use the supervised audio fixture with `-Extended -Long`. [Dedicated TURN configuration and deployment procedure](screen-turn.md)
- Use the same moving local gameplay clip via `RAJCORD_SCREEN_BENCH_VIDEO` for congestion comparisons. Set `RAJCORD_SCREEN_BENCH_RECOVERY=1`, `RAJCORD_SCREEN_BENCH_VIEWER_ISOLATION=1`, `RAJCORD_SCREEN_BENCH_VIEWERS=2` and `RAJCORD_SCREEN_BENCH_SECONDS=10` for the 2 Mb/s single-viewer cap. In a separate run clear both isolation and recovery flags, set `RAJCORD_SCREEN_BENCH_SHARED_UPLOAD=1` and select `2,3` viewers to share one 6 Mb/s cap. Both use a 16-second cap with packet loss and jitter. The recovery check requires two consecutive three-second windows with at least 90% of the baseline received bitrate and presentation rate at 1080p on the same ICE pair. To record an owned Freedoom run, set `RAJCORD_SCREEN_BENCH_RECORD` to a new `.webm` path, set one Electron viewer and use the live gameplay inputs below.
- Set `RAJCORD_SCREEN_BENCH_RECOVERY_RAMP=1` to restore capacity in stages. With shared upload enabled, `RAJCORD_SCREEN_BENCH_SHARED_VOICE_PORT` points to an owned loopback LiveKit UDP port. Use the portable Windows LiveKit server with `rtc.use_ice_lite: true`, `rtc.enable_loopback_candidate: true`, and `rtc.ips.includes: [127.0.0.1/32]`. Wait for the control endpoint to respond before starting the fixture. Keep the disposable PostgreSQL and LiveKit settings in the fixture environment. The browser uses a synthetic microphone and verifies that the selected publisher route uses the shared queue. The report records voice packet loss, concealment, buffer delay and aggregate relay traffic. [LiveKit fixture build](https://github.com/livekit/livekit/releases/tag/v1.13.10) · [LiveKit ICE configuration](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- Run `node scripts/test-obs-screen.mjs` with `RAJCORD_SCREEN_BENCH_EXPECT_UNPADDED=1` and no recording or game selected to check content-dependent bitrate. The built-in animation must present at 1080p near 60 fps and use less than half the selected ceiling for every viewer.
- Run `node scripts/test-obs-av.mjs --startup-cycles=20` in a visible Windows terminal for interactive stop and restart tests with scoped application sound. Add `--system` for full-display audio. Use `RAJCORD_SCREEN_BENCH_BUNDLE` to select a separate runtime. Each cycle checks native PCM, decoded H.264 and Opus, the authorized 440 Hz tone, and exclusion of the 1247 Hz tone. Confirm permissions after each cycle. A declined or missed confirmation, a media failure, or a Windows audio service failure stops the batch.
- Run `node scripts/test-obs-av.mjs --assert-fresh-audio` for a short selected-application flash-to-tone smoke check and source-process closure. Use `--system` with a separate source display for full-display audio. For matched fullscreen sources compare `--matched-display --layered` with `--system --layered`. Add `--rejoin` or `--three-viewers` in separate runs. The default audio detector uses Web Audio and the visual detector uses Chromium frame-presentation callbacks. `--rendered-audio` adds calibrated timing from a single playing video element using loopback on the owned viewer process. The display fixture excludes the co-located viewer's process tree from rendered-output measurements to avoid feedback. Use the same clock, detector, source geometry and viewer count when comparing changes. Increase `--seconds` when investigating a noticeable drift. Set `RAJCORD_OBS_AV_DEBUG=1` for native capture, encode and RTP timing stages. In a startup run, `--sample-scope` collects extra spectral windows and `--silent-decoy` runs the same source process with no signal for a control. The normal 30 dB assertion remains active in both cases.
- To exercise screen Opus, video and synthetic LiveKit voice together, run `node scripts/test-obs-av.mjs --shared-voice-port=20972 --matched-display --layered --assert-fresh-audio` from an attended terminal. Use the same disposable LiveKit configuration and substitute its local UDP port. Wait for the selected LiveKit route to be verified, then follow the audio prompts. The fixture measures both audio streams and video before, during and after an 850 kb/s cap with loss and jitter.
- For live gameplay, set `RAJCORD_SCREEN_BENCH_DOOM` and `RAJCORD_SCREEN_BENCH_IWAD` to the local Chocolate Doom executable and Freedoom 2 IWAD. Clear video and optical-marker settings and set `RAJCORD_SCREEN_BENCH_SECONDS=6`. The fixture checks game-window ownership and records the same timedemo with and without sharing.

Use an indexed clip to measure distinct underlying video frames. Run with `RAJCORD_WGC_TEST_STOCK=1` to compare the stock capture interval, then clear it for the standard OBS sender. The desktop helper environment excludes that fixture control.

### Supervised Windows audio tests

Keep the same bundle path and binaries for both scopes. In the Windows desktop session, use `--list-audio-executables` with the planned test options to print the resolved paths and the helper hash without opening an audio device. Kaspersky may describe process-loopback access as microphone access. Compare the path shown in each prompt with the list and grant access only for the matching executable. The test uses Electron for the generated source and viewer and `rajcord-obs.exe` for source PCM. Setup builds a separate `dist/rajcord-obs-playout.exe` for the optional rendered-audio observer.

```powershell
$env:RAJCORD_SCREEN_BENCH_BUNDLE = (Resolve-Path apps/desktop/native/obs/dist/bundle).Path
node scripts/test-obs-av.mjs --list-audio-executables --rendered-audio --matched-display --layered
node scripts/test-obs-av.mjs --rendered-audio --assert-fresh-audio --matched-display --layered
node scripts/test-obs-av.mjs --rendered-audio --assert-fresh-audio --system --layered
```

Run each scope separately and stay present. Type `READY` to let the warm-up open the devices and trigger any permission prompts. Once the listed executables have attempted audio access, clear any matching Kaspersky prompt and type `GRANTED` to begin the checks. If opening the devices timed out, the result is inconclusive. The next run can reuse the same executable permissions. Confirm again when the run finishes. A missed or declined confirmation leaves the result inconclusive. The fixture checks both Windows audio services and their termination records, timestamped PCM and the expected decoded tones. Rendered A/V timing is reported for diagnosis. Judge practical playback through an attended viewing session with the intended source and hardware.

### Test application and game playback with friends

1. Use a private test voice room and accounts on a Rajcord host with compatible OBS screen signaling. The packaged Windows app connects to `https://rajcord.com`. Check host compatibility before using the private test installer on a spare Windows account. Friends can join using a compatible browser or desktop client.
2. Join voice. On the Windows publisher, set **Source sound** to application audio, open **Share Your Screen**, select the game or application under **Applications**, inspect the preview and start the share. Stay available to handle a permission prompt for the exact executable.
3. Have one friend watch a moving clip or a game with sound. Check speech, impacts or other short sounds against their visible actions. Play something in a different application to check isolation. On the viewer, change the selected speaker and adjust the share volume while talking in voice.
4. Add viewers up to three, change the broadcaster’s resolution or frame rate with **Apply stream quality**, and have a viewer leave and rejoin. Alt-Tab and resize the selected window, minimize and restore it, then close it. Start another share and use Stop. Check for screen audio ending and voice continuing.
5. After the short session works, repeat on separate networks with one viewer on a hotspot and record the selected ICE route. In a 30–60 minute attended session, listen for drift, interruptions and voice degradation. Record the game, display mode, helper build, GPU and which action preceded a problem.

### Windows Audio hang capture

Run `pwsh -NoProfile -File scripts/trace-windows-audio-hang.ps1` to validate the WPR profile and query the current PowerShell thread's wait chain. This check leaves tracing off. If a symptom can be observed during ordinary testing and an administrator session is explicitly approved, run the same command with `-Capture -Seconds 45`. Press Enter at the first symptom. A service state or host PID change also triggers the snapshot.

The script uses a uniquely named 48 MiB circular WPR profile with Windows Audio, audio engine, and SCM events plus scheduler stacks. It obtains the current Audiosrv host and audio engine PIDs at the time of the wait-chain query. The worker has seven seconds and writes each completed query to `wait-chains.jsonl`. The script stops or cancels its own named tracing session and retains at most a 128 MiB compressed ETL under ignored `.local/windows-audio-traces`. It also saves UTC trigger time, SCM record IDs and helper PIDs. Use WPA to compare process and scheduler waits with audio events. ETL may include system process/image metadata, so retain it locally. [WPR command reference](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options) · [Windows wait-chain API](https://learn.microsoft.com/en-us/windows/win32/api/wct/nf-wct-getthreadwaitchain)

Correlate the capture window with the fixture's stage HRESULTs and the Kaspersky Intrusion Prevention report. If needed, use `avp.com REPORT HipsTask /RA:<temporary-report-file>` from the installed Kaspersky CLI. Keep only rows for the capture window and audio permission decisions affecting the exact helper or probe path. Match timestamps, PIDs when present, and file hashes. Keep unrelated application entries and account details out of the incident evidence.

```powershell
python scripts/make-indexed-screen-clip.py --output .local/obs-indexed-1080p60.mp4
$env:RAJCORD_SCREEN_BENCH_VIDEO = (Resolve-Path .local/obs-indexed-1080p60.mp4).Path
$env:RAJCORD_SCREEN_BENCH_MARKER = '1'
$env:RAJCORD_SCREEN_BENCH_INDEXED = '1'
$env:RAJCORD_SCREEN_BENCH_SECONDS = '15'
node scripts/test-obs-screen.mjs
```

Compare these results with the [audio startup and source provenance checks](verification.md#obs-audio-startup-and-source-provenance--2026-11-22) and the [coturn release gates](verification.md#dedicated-coturn-and-capture-clock-qualification--2026-11-22). For reproducible production acceptance, use a standard-user Windows 11 clean installation and two consenting test accounts.

1. Install the exact audited build on Windows without OBS Studio or a GStreamer SDK. Run the [installer fixture](desktop-distribution.md#acceptance-and-windows-checks). Launch the installed app and test the picker, preview/authorization, application audio, full-display audio, Stop and Quit. In Electron and then a browser viewer, verify decoded H.264 and audible Opus. Uninstall and verify shortcut/registration cleanup and profile preservation.
2. Put the desktop publisher and viewer on separate networks, such as a wired home connection and a cellular hotspot. Start voice, share a visible 1080p60 flash/tone source, and record first rendered frame, selected ICE candidate types, presented/decoded FPS, loss, retransmissions, latency and audible continuity. Repeat on an isolated client with direct peer UDP blocked and TURN UDP allowed, and with a TLS-capable viewer restricted to TLS TURN. Verify decoded media for each chosen pair. Repeat with both peers requiring a relay. Use the [dedicated coturn configuration](screen-turn.md) for approved staging and production qualification. The deployed embedded LiveKit relay still limits its own addresses to RTC media ports, which excludes its separate relay range.
3. Interrupt the viewer connection for six seconds, restore it and check ICE restart and fresh frames, then leave and rejoin the share. Check unchanged voice continuity where the network still permits voice. On the authorized server diagnostics, record relay allocation and expiry/renewal handling without logging credentials or addresses. Repeat at representative ten-person call load with two viewers.
4. On physical Radeon Windows hardware, record the OS, GPU, driver and selected encoder. Test Automatic and explicit AMF using a changing 1080p60 source and three viewers. Inspect decoded H.264 and cadence in Electron and a browser. Change quality during playback. Repeat on a device without usable AMF for explicit failure and Automatic fallback, and on dual-GPU hardware with the share on each GPU's display.
5. While a test tone plays, change the publisher's default output, then unplug or disable the active device in an isolated test session. Verify sound resumes from only the same authorized scope or the share surfaces capture failure. On the viewer, switch the exact speaker, invalidate it and restore it. Verify mute/deafen, scoped audio and voice independently. Measure A/V at startup, after restart/rejoin and after at least three minutes with a second workload.

## Historical screen-sharing notes

The dated notes below describe earlier implementation and qualification work. The Windows OBS section above describes the current desktop publisher and its audio controls.

Updated 2026-11-19. The media recovery and quality continuation below describes the current source changes. The preceding call redesign and account/chat polish were integrated with modularized `develop` on `feature/call-workspace-redesign`, preserving the original `feature/screen-sharing-completion` checkout. This is source implementation evidence, not a production deployment, signed release, or physical/WAN performance qualification. This document supersedes the old slice-1 continuation prompt; dated evidence remains in [verification.md](verification.md).

## Call UI continuation - 2026-11-15

The 2026-11-16 continuation also fixes call join/leave navigation, retained stream audio controls, stale participant popups and retired playback errors. Account/settings recovery and chat submission/GIF/edit guards have accompanying regressions. See [integration verification](verification.md#call-redesign-integration-with-develop---2026-11-16) for current evidence and the unresolved desktop notification opt-in smoke prerequisite; the preceding [polish verification](verification.md#call-account-and-chat-polish---2026-11-16) describes the original checkout.

The local redesign keeps the existing call/session/media ownership. Clicking a voice channel joins or switches muted and opens the call grid; device discovery/selection lives in Settings > Voice & audio. A compact participant popup exposes local volume on click/right-click in both the sidebar and call tiles. Saved exact device IDs are checked before a switch, and leave cancels pending discovery.

The call view has a focused stream, persistent participant strip, floating controls, balanced grid, Watch Stream replacement and explicit multi-view up to nine incoming streams. The isolated desktop source chooser has Applications/Entire Screen tabs, local thumbnails and explicit source-audio consent. Browser source choice remains native. A silent local preview and explicit Start remain required. Resolution and frame rate stay independently selectable. Unsupported camera sources and paid/promotion features are not presented.

Two-publisher synthetic loopback verification now covers multi-view through the original grant deadline and delayed hidden-selection cleanup, restoring every remaining stream with its quality and previous grid layout. This remains local implementation evidence; the physical/WAN and release gates below remain open. See the [redesign verification](verification.md#discord-style-call-ui---2026-11-15).

## Reliability and impairment continuation - 2026-11-18

Source/content/budget maintenance survives hung or unsupported native statistics. Exact-owner fencing covers renewal, publisher startup and late signal completion; concurrent watched-stream recovery waits for selection/cleanup, and reentrant Stop cancels before dispatch. Screen commands use a bounded cancelable queue so fan-out signaling fits the existing server authorization budget without raising it. Unchanged directory polls authorize the recipient without repeating whole-fan-out authorization or delivering data; changed snapshots retain fresh authorization for every included source/link.

Use `pnpm test:screen:network` for measured loss/bandwidth/delay/jitter through the owned loopback-only authenticated relay. It verifies native retransmissions, continued source media, recovery and empty allocation/packet queues after cleanup. It does not test the production LiveKit TURN service, TLS or remote NAT. See the [current audit evidence](verification.md#screen-system-reliability-and-impairment-audit--2026-11-18).

The nine-viewer correctness case passed with watchers capped at 720p15 and a shared 4 Mb/s publisher budget, alongside generated voice, renewal, two-publisher multi-view, hide/resume and Stop. Applied ceilings and received picture do not prove sustained rendered FPS. The nine-viewer high-rate stress attempt failed, including in isolation; that capacity gap remains open.

## Content-aware fidelity continuation - 2026-11-18

This supersedes the first-pass quality heuristic below. One local 64 x 36 sampler per consented source detects sustained motion at up to five samples per second, with hysteresis for cursor changes, short movement and settling. It sets the shared capture hint; explicit-format senders keep their fixed degradation preference for both content types. Stop/expiry/source loss disposes the sampler without stopping someone else's borrowed track. Status is explicit if analysis is unsupported or fails, and detail remains the fallback. Pixels never leave this local analysis path.

H.264 can be preferred only after the browser reports supported, smooth and power-efficient encoding for the requested publisher quality. The 300 ms bounded qualification is shared per source and canceled on Stop. Missing/negative/error/timeout reports retain browser defaults. Native preference failure restores defaults and remains visible in local diagnostics. No fallback codec or RTP repair capability is removed, and no AV1/VP9 software encoder is forced. The report is an estimate, not hardware qualification.

In the earlier shared-budget implementation, the application preserved selected resolution/FPS ceilings when dividing the publisher's bitrate budget. It delegates congestion/CPU adaptation to WebRTC instead of repeatedly cutting its bitrate ceiling or multiplying downscaling merely because an allocation is smaller. Local diagnostics now include target/retransmit bitrate, codec-specific quantizer and reported encoder power efficiency. The qualification harness adds exact synthetic-reference RGB/luma PSNR and uniform-block/detail-region SSIM, explicit detail/motion A/B policies, and a genuinely static source. Its numeric quality proxies do not establish human legibility, WAN behavior, device-wide hardware efficiency or a universally best codec. See [current fidelity evidence](verification.md#content-aware-screen-fidelity---2026-11-18).

## Media recovery and quality continuation - 2026-11-18

The first pass added local, sanitized two-second screen-peer statistics and application pressure heuristics. The content-aware continuation above supersedes those heuristics and its original codec policy. The explicit feasibility harness accepts VP9, AV1 and synthetic small-text content alongside VP8/H.264 and motion/stress content. Harness metrics do not establish perceptual quality or hardware efficiency.

Each direct viewer has an independent video bitrate cap. The sender uses the lower of the publisher's selected bitrate and that viewer's requested bitrate. Two viewers capped at 12 Mb/s each can use about 24 Mb/s of publisher video upload, plus audio, retransmissions and transport overhead. Actual video bitrate depends on the source and network.

ICE failure receives bounded publisher-led restart attempts with freshly renewed ICE configuration. Incoming failure can request a fresh authorized selection after clearing the old selection. Stop, visibility, source, binding and authorization changes cancel recovery when they invalidate the link. A screen signaling disconnect ends sharing. When a peer loses authorization during renewal, the server removes that peer's links. A stale continuation restarts from page one and the fresh renewal keeps healthy links. Window dimension changes clear obsolete quality readback and are reapplied without selecting another source. A dimension change during an in-flight limit update invalidates that update.

`ScreenControls.inspectMedia()` returns local samples and explicit statistics availability without addresses, titles, device identifiers or media. Missing counters and static desktop frames are not treated as transport failure. Statistics failure does not end healthy media; timed-out raw statistics work retains admission until settlement. There is no remote collection or persistence.

These changes do not configure production TURN, add a port-443 relay, alter the main-window Stop limitation, qualify sustained hardware/WAN behavior, or change production codec preference. Use the manual acceptance gates below before release.

## Current continuation - 2026-11-13

The source branch was `a30525f`; fetched `develop` was `05bb0ca`. Both remote tips were rechecked unchanged during completion. The original 69 completion files (51 tracked modifications plus 18 new files) and staged upstream integration were snapshotted before continuation. The integration includes current `origin/develop` at `05bb0ca`. The user has now authorized a feature-branch commit/push and PR to `develop` after validation. Shared-branch merge, deployment and desktop rollout remain separately gated.

The user's requirements were internet P2P, independently selectable resolution and frame rate, separate video bitrate, and sharing in the main window. Choices are 480p/720p/1080p, 15/30/60 fps and 2/4/6/8/12/20 Mb/s. The November 13 implementation shared the publisher's bitrate across viewers. The media recovery and quality continuation above describes the current per-viewer caps. Ultra/4K remains deferred.

The dedicated screen policy keeps Cloudflare STUN and prefers direct ICE. Optional `SCREEN_TURN_HOST=turn.rajcord.com` reuses the pinned LiveKit 1.13.10 TURN service on its existing UDP 3478/TLS 5349 listeners. The API issues separate 60-second TURN allocation credentials after exact screen-binding authorization and refreshes them on renewal; no LiveKit room JWT/API secret enters the renderer. Credentials stay in memory. The setting is off until explicitly configured. Existing LiveKit relay destination/quota policy still applies; forced relay media, especially two peers using the same VPS relay, remains a manual acceptance gate. No additional VPS service/port is proposed.

## Implemented composition

- `VoiceController.bindScreens` privately delegates the exact current lease. Copied/frozen replies, request-start deadlines, lease/generation fences and retained raw bind/retirement admission prevent stale adoption. No lease/Room/JWT getter or binding control enters VoiceControls.
- One bootstrap-owned `ScreenRuntime` retains the capture adapter, bounded incoming pool and binding admission across React StrictMode, session/provider replacement and suspension. A failed optional screen owner does not prevent microphone voice.
- One dedicated cookie/CSRF-authenticated screen socket belongs to the approved session/exact binding. It does not reconnect or share AuthRoot's chat socket. Screen protocol 2 rejects older versions explicitly.
- C1 capture preparation requires the same session, exact lease and connected S1 binding. Main derives native frame/navigation identity and independently authenticates Session.fetch with HttpOnly cookies. Renderer correlation tags and epochs confer no authority.
- C2 publish returns a finite `{share, remainingMs}` proof; renew asserts the exact live own publication. Main promotes consumed preview authority into a distinct publication record and checks it independently. Replays retain absolute deadlines; voice heartbeats alone cannot revive publication.
- CaptureSession atomically changes preview supervision to publication while retaining the adapter/result/tracks. Explicit branded renewal is adopted by binding, source, peer, incoming and playback owners before the old deadline. Source/session/lease loss remains a root stop; old preview callbacks cannot stop a promoted source.
- The actual main-window UI supports preparation, fresh-gesture source choice, silent local preview, explicit Start, independent outgoing and watching quality, source-sound consent, watching, screen mute/volume, exact selected output, hide/resume and reachable Stop. Publisher video ceilings are installed before an offer and confirmed after negotiation. At zero viewers there is no outgoing screen peer/RTP.
- Windows desktop audio follows source selection automatically: application windows use that app's process-tree audio; whole displays use system loopback. There is no Windows sound dropdown or second sound choice in the picker. Its read-only summary discloses the audio scope before source confirmation. Other windows of the selected app may be included; system sound can include every application and call playback. Rajcord's own windows and windows with unverifiable processes remain unavailable for app-audio capture. Source-sound failure never silently becomes video-only or another audio scope. The Windows application path uses the pinned Electron runtime's undocumented Chromium device-ID pass-through and fails closed outside its allowlist; `pnpm test:desktop:app-audio` qualifies isolation between owned synthetic processes. Browser sharing remains video-only by default, with explicit Edge tab sound. These paths do not certify physical routing, intelligibility, feedback isolation or sync.
- Browser video-only capture may omit `displaySurface`, as Firefox does. The local capture then records an unknown surface instead of inventing a tab/window/monitor classification. It still requires the browser picker, exactly one live video track and no audio. Tab/system sound and desktop capture retain their verified source-type checks.
- Hiding/minimizing closes incoming delivery and conditionally unselects its exact old revision. Duplicate native/document visibility notifications preserve the saved watch selection. Returning waits for that cleanup, then requests the current publisher ceiling if source and binding identity are still current and watching is active. Outgoing sharing continues. Screen Stop is available in the sidebar/panel and native menu/tray.
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

The actual app screen fixture uses port 3012, two, four or ten disposable accounts, generated canvas video/PCM source sound and fake voice devices. It verifies preview consent, independent quality, direct candidate types, source/audio delivery, live viewer FPS changes, renewal beyond the original deadline, hide/resume limits and Stop preserving voice. It does not capture a private desktop or certify physical playback. The fan-out cases check independently received video and cleanup while one viewer hides/resumes; the nine-viewer case also checks voice audio bytes growing at every client. Use `pnpm exec vitest run --config vitest.browser.config.ts apps/web/src/features/screen-sharing/screen-call.browser.integration.test.ts` after building to select it.

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
