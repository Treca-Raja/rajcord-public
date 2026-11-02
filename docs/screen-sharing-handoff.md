# Screen-sharing contributor and GPT handoff

Prepared 2026-11-02 for continuing `feature/screen-share-design`. Screen sharing is **not available in the app**. The branch contains tested server/headless components and isolated runtime fixtures; production capture remains disabled. Continue one bounded slice at a time with **GPT-6.1 Sol, high thinking, in Codex on the checkout**.

## Start here

1. Read [AGENTS.md](../AGENTS.md), then inspect `git status --short --branch` and `git worktree list`. Preserve staged, uncommitted and unrelated work.
2. Read the [current production specification](screen-sharing-design.md#production-authority-and-capture-handoff-specification), [ordered Sol packet](screen-sharing-design.md#dependency-ordered-sol-packet) and [canonical next prompt](screen-sharing-design.md#sol-handoff-next-prompt). The [SVG concept](screen-sharing-concept.svg) describes intended interaction, not implemented UI.
3. Consult only the relevant dated sections of [verification.md](verification.md), especially the receiving-lane fixture and production authority specification near the end. Older sections describe earlier checkpoints; their “next task” statements are historical.
4. Inspect the affected source/tests before editing. Do not restart the architecture investigation, repeat S0 benchmarks, or interpret a design proposal as an implemented grant.

### Branch and upstream state

Preparation began at `264fcc7409c8f776819ba70abb60bfe877434a96`, with an empty index and the screen-sharing work still uncommitted. No remote `feature/screen-share-design` existed when checked. The handoff becomes transferable only after its source, tests, fixtures, contracts and documentation have been committed and pushed together; pushing the old base alone would transfer none of that work.

On 2026-11-02, fetching `develop` found `origin/develop` at `05bb0ca60277eb642ae6069a25cd53e64b8c3025`, **21 commits ahead of this branch's base**. Those changes include application sounds, presence, chat and delivery work, with overlapping edits in Auth, VoicePanel, voice-controller, Electron main, API app and shared contracts. No upstream merge/rebase was performed. Recheck the remote: these are dated tips, not permanent destinations. Integrate upstream in a separate scoped task with regression checks before considering this feature ready for a PR against `develop`; do not silently overwrite either side or rewrite applied migrations. Historical green results do not qualify the merged result.

For a fresh machine, clone the feature branch after it has been pushed, using the repository linked in [README](../README.md). If already cloned, inspect local work before fetching/checking out; never reset to make the branch match. Verify the remote destination and outgoing range before publishing. Feature PRs target `develop`; no push, merge or deployment is implied by the GPT prompt below.

## What exists and what does not

| Area                     | Current implementation/evidence                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 API                   | Ephemeral screen state, exact session/channel/voice-lease authorization, synchronous lease invalidation, bounded authenticated signaling, private directory/link delivery and server capture-authorization routes. Unit/disposable API fixtures exist.     |
| S2 capture               | Web adapter, desktop consent policy, isolated picker, default-disabled native boundary, main/server authority and headless preview ownership. An actual Electron Session.fetch + HttpOnly cookie + disposable API + test-owned WebContents fixture exists. |
| Auth and voice ownership | Verified approved-session call owner, persistent call across panel remount, stale logout/session fencing and delayed revocation-cookie fixes. Existing microphone-only LiveKit voice remains separate.                                                     |
| S3 media components      | Headless ScreenPeer, experimental per-link quality/manual video bitrate policy, ScreenPlaybackOwner and receive lane. Construction/replacement/deadline/cleanup races have focused coverage.                                                               |
| Native receiving fixture | Real browser peers, generated video/audio, authenticated API signaling and actual receive-lane composition. Video inspection is silent; independently decoded Opus proves received encoded audio, not audible speaker playback. Output elements are fakes. |
| Production handoff       | **Proposed only.** Private exact-lease delegation, document-owned runtime/admission, C1 capture-binding correlation, C2 publication proof/renewal and atomic CaptureSession supervision still need implementation.                                         |
| App feature              | No screen UI, production preparation trigger/opt-in, capture-owner/publishing/receiving wiring or reachable screen Stop indicator yet. Do not advertise a working app feature.                                                                             |

Latest pre-handoff evidence records **746 portable tests across 46 files** and **63 browser cases across three files**, with workspace typecheck/lint/build passing. These are dated results from the previous implementation checkpoint, not proof that tests ran on your machine. The handoff preparation checks are recorded separately in [verification.md](verification.md#screen-sharing-contributor-handoff---2026-11-02).

During handoff preparation, all **746 portable tests**, workspace typecheck, lint and build passed again. Full `pnpm format:check` reports **101 unchanged files with checkout CRLF endings**: every warning was verified against its formatted LF `HEAD` content. Do not reformat that unrelated work as part of the next feature slice; preserve `.gitattributes` and distinguish local checkout normalization from a source change. Browser/database/Electron/voice runtime suites were not rerun for this documentation-only handoff.

### Constraints to preserve

- Prioritize working **1080p60**, a **separately selectable video bitrate**, and **explicitly consented source sound**. Ultra is later work.
- Screens use direct WebRTC; LiveKit remains microphone-only. Do not borrow its tokens, rooms or TURN settings for screens.
- Hidden/minimized must stop incoming delivery; outgoing sharing and reachable Stop must continue. Local element detachment or cleanup completion does not prove remote acknowledgement or zero incoming packets.
- Account IDs, renderer booleans, lease/link/epoch references and local deadlines are not authorization. Reauthorize fresh sessions and exact leases server-side; derive native frame/gesture identity in main.
- Logical Stop/cancellation/timeout must act promptly, while unresolved native/HTTP/RTC/cleanup work retains admission until actual settlement. Recreating an owner/wrapper must not bypass limits. Old work cannot stop a replacement.
- Preview expiry remains a hard stop. Do not extend existing deadlines from heartbeat/local snapshots, cast tab sound into system sound, fabricate grants, or transfer only tracks and then dispose their owning adapter.
- Keep production capture disabled and source/audio policies unqualified. Use synthetic media and disposable accounts/databases/profiles/rooms only. No private desktop, microphone, speaker, real account data, resets or volume removal.

Physical picker/source identity, Windows system/Edge tab sound, native audible output/routing, feedback/sync, sustained **rendered** 1080p60, hardware/approved budgets, active voice plus fan-out, actual bitrate wire effects, hidden packet cessation and consented WAN/STUN remain gates. Requested/read-back ceilings and decoded FPS do not qualify them. Main currently fences pending native requests; it does not establish independent stopping of already-issued renderer tracks when that renderer is suspended/unresponsive.

## Exact next development slice

The S3 Astra packet's tasks 1–4 are complete. **Do not rerun “Astra task 4.”** The next implementation task is **production packet slice 1: private exact-lease screen-binding delegation**, as specified in the canonical prompt. It is not a production adapter.

Affected files: [voice-controller.ts](../apps/web/src/voice-controller.ts), a new `apps/web/src/voice-screen-binding.test.ts`, relevant [lease lifecycle tests](../apps/web/src/voice-lease-lifecycle.test.ts), and the existing design/checkpoint/evidence sections. Reuse shared ScreenBindRequest/ScreenBinding contracts. Keep the injected factory absent in production and do not expose the method through VoiceControls.

Critical detail: VoiceController can recover to a different private lease **without changing its call generation**. Fence both exact lease object identity and generation, plus wanted/disposed state, before allocation and after every await. Register retirement immediately on allocation, strictly validate/copy/freeze the binding reply, and calculate its conservative deadline from request-start time. Use the specified five-second prototype logical bound without freeing the unresolved raw bind/retirement slot. Test late and reentrant outcomes and explicitly drain fixtures.

After that comes the persistent injected runtime shell. **GPT-6 Astra high review is highly recommended before implementing C1/C2's new authentication/native permission/publication/renewal contracts**, using the focused prompt in the specification. It need not interrupt the first two isolated injected slices. Independent active-screen stop enforcement must also be resolved before qualification/enablement. Do not use a general review as a substitute for physical/runtime evidence.

## Setup and checks

Use Node **24+** and pnpm **11.25.0**, matching [package.json](../package.json). In a fresh clone:

```powershell
pnpm install --frozen-lockfile
pnpm build:packages
```

The next injected delegate slice needs no database, LiveKit, Electron runtime or physical devices. Start with the relevant synthetic tests, then workspace checks:

```powershell
pnpm exec vitest run apps/web/src/voice-screen-binding.test.ts apps/web/src/voice-lease-lifecycle.test.ts apps/web/src/voice-session.test.ts apps/web/src/call-preview.test.ts
pnpm test --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
git diff --check
```

`voice-screen-binding.test.ts` is the intended new regression file; it does not exist at this checkpoint. Write it as part of the slice before running that selector. Keep full portable tests separate from browser/service fixtures when investigating startup failures; the prior receiving-lane checkpoint records an intermittent startup/reload failure and its successful unchanged standalone rerun. Do not remove assertions or increase limits to hide it.

For later integration work, follow [README setup](../README.md#setup-and-first-owner) and the [verification skill](../.agents/skills/rajcord-verify/SKILL.md). Generate your own ignored local configuration; never copy another developer's `.env`, cookies, database, profiles or `.local` tool directory. PostgreSQL/LiveKit fixtures require loopback services and an appropriately scoped local test role. Keep existing credentials/data intact; no new owner is needed merely to run synthetic tests.

After required setup/build, available commands include:

```powershell
pnpm test:db
pnpm exec vitest run --config vitest.browser.config.ts
pnpm test:desktop:picker
pnpm test:desktop:capture
pnpm test:desktop:authority
```

Use only checks applicable to the change. The browser config includes the mounted owner, cookie race and native receiving-lane fixtures; the native screen fixture needs local PostgreSQL/LiveKit and Edge. Electron fixtures need `pnpm setup:desktop`; the authority fixture also needs the disposable API services. Fixture ports and detailed prerequisites are in README/distribution/verification. None of these commands qualifies physical sound/display capture. Do not run `pnpm test:screen` (S0 probes) without a relevant media change. Report unavailable prerequisites honestly and explicitly settle/drain fixture-owned work before teardown.

## Copy-paste prompt for your GPT

```text
Continue Rajcord screen sharing on feature/screen-share-design in this checkout.
Use GPT-6.1 Sol high in Codex. Read AGENTS.md and docs/screen-sharing-handoff.md.
Inspect branch/worktree/status and source drift first; preserve all existing work.
Note the recorded upstream develop drift; do not silently merge/rebase/reset it.
Read only the current production specification, ordered packet, canonical next prompt
in docs/screen-sharing-design.md, relevant verification evidence and affected source/tests.

Execute only production packet slice 1: private exact-lease screen-binding delegation
inside VoiceController with a trusted lazy injected bind/retire transport. Follow the
canonical prompt's acceptance criteria. Fence exact private lease identity as well as
call generation/wanted/disposed state; recovery can change the lease without generation.
Admit before native/transport allocation, register cleanup immediately, validate/copy/freeze
the response, and retain one unresolved raw bind/retirement through logical timeout,
cancellation, leave/disposal and late results. Do not expose lease/Room/token internals.

Add deterministic synthetic/deferred/fake-clock regressions, drain all fixture work,
run appropriate focused/portable/type/lint/build checks, and record actual results.
Update the existing checkpoint: persistent injected runtime shell is next. Keep C1/C2
as proposed contracts pending focused review. No production factory or VoiceControls
injection, real screen sockets, provider/UI/IPC wiring, capture, opt-in, publishing,
peers, physical devices, S0 probes, Ultra work, tickets, commits, pushes, merges or deploys.
Preserve microphone-only LiveKit voice, source-sound consent and all open media gates.
If current source has moved beyond this checkpoint, identify the concrete delta before
selecting work; do not implement a duplicate delegate or restart the whole investigation.
```
