# Informational CI and release-path split — 2026-10-30

Implements the "Make CI informational and remove redundant checks" ticket. `verify` and `build` were removed as **required** status checks on both `develop` and `main` after the maintainer's explicit confirmation. Before and after protection JSON was saved outside the repository and compared: the only difference on either branch is the removed `required_status_checks` object. Review requirements, administrator enforcement, force-push/deletion restrictions, the `main` lock and the active `main` ruleset are unchanged. Roll back by restoring the saved required checks (`verify` and `build`, GitHub Actions app `15368`, strict).

Workflow changes: pull requests and `develop` pushes use the new `ci.yml`, so a PR shows one verification run instead of a `push`/`pull_request` pair. `verify.yml` is now the main-only release workflow (pushes to `main` and manual dispatches), so no skipped publish/production jobs appear on PRs. Its jobs, conditions, environment approval, `publish_only` handling and release commands are unchanged. The PR source/base check moved to a separate `PR policy` workflow. The Windows PR build is limited to relevant paths and skips the format, lint, type and unit steps already covered by `CI`; pushes and manual desktop releases keep every step.

- `scripts/workflow-policy.test.ts` (6 tests) pins the trigger split, absence of release capabilities from PR workflows, `publish`→`production-policy`→`production` dependencies on the same run's `verify`, drift protection between the two verification jobs, the PR-policy workflow and the desktop path filter. Two deliberate mutations (a PR trigger added to the release workflow; `publish` no longer needing `verify`) were each caught.
- The 36 focused workflow/PR-policy/release-policy/desktop-release tests passed; all workflows passed the same pinned actionlint image used in CI.
- **Not exercised:** the main-only path itself. It cannot run until a commit reaches `main`, and no workflow was dispatched or published. After the first release PR merges, watch the `Verify` run, or dispatch `publish_only=true` with `HOSTING_ENABLED` unchanged, before relying on it. The new `CI` workflow is exercised by this PR's own checks. Merging with failing checks is now permitted by design; a real test PR with a failing check should confirm it.
# Reply-target restoration review fixes — 2026-10-30

Two review findings on #19 were reproduced and fixed. Choosing a new reply target now invalidates any pending restoration of an older one, so the displayed target and the sent `replyToId` cannot diverge. A restoration failure clears the retained target only for HTTP 403/404; network errors and 5xx keep it, pause sending and show Retry and Cancel reply.

Verification: `pnpm exec vitest run --maxWorkers=1` passed **468 tests in 56 files** (new status-classification and composer-state tests); `pnpm lint` and serial workspace typecheck passed; `pnpm --filter @tricord/api test:browser` **passed** with new held-response and HTTP 503 assertions (retained draft, paused send, Retry, correct `reply_to_id`). With the fix reverted, the held-response assertion failed as expected. One unrelated earlier run of that reverted-code check timed out waiting for the socket connection and was not counted. DB, voice, desktop, image and hosting suites were not rerun.

# Develop merge with presence and voice sounds — 2026-10-30

`develop` (`f00e3e2`) was merged into this branch after #18 (application sounds) and #16 (live presence) landed. Their merge into develop was an exact union of the two PRs; conflicts here were resolved from a local rehearsal that was run on all three PRs.

- Message alerts keep this branch's notification system (Settings → Notifications, coordinated tabs, one sound path). #18's sound player now handles voice join/leave cues only; the sidebar control is labelled "Voice sounds". This avoids two sound systems playing the same alert and is a decision for #18's author to confirm.
- #16's member panel was kept and its presence colours now use the shared theme tokens. The desktop smoke's localStorage check now allows notification and theme preference keys alongside sound preferences.
- A stale popup-count expectation inherited from #18's browser test compared against a literal `1`. It now compares against the count taken before sounds are enabled.

Verification on the merged branch: `pnpm format:check`, `pnpm lint`, serial workspace typecheck and build passed; `pnpm exec vitest run --maxWorkers=1` passed **461 tests in 55 files**; `pnpm test:db` passed **124 tests in 9 files**; `pnpm --filter @tricord/api test:browser` **passed** with the configured Linux Chromium launcher after the assertion above was corrected. The first two browser attempts failed on that assertion and are recorded here rather than hidden. Desktop, voice, image, hosting and Windows/physical-device suites were not rerun.

# PR CI failure and browser-harness regressions — 2026-10-30

The PR's Linux `verify` job failed in `pnpm test:db`: one provider-list assertion in `gif-search.integration.test.ts` removed only the GIPHY key while the fixture also configured KLIPY, so KLIPY correctly stayed enabled. The test now removes and restores both public keys. The full database suite had not been rerun after adding KLIPY.

Rerunning the real-Chromium harness on the final head found two further regressions that CI's `verify` job does not execute:

- The reply-selection frame used a pseudo-element bleeding 6 px beyond its row, so rows reported horizontal overflow at 390 px. It now uses background, box-shadow and outline, which add no scrollable overflow. `overflow: clip` with `overflow-clip-margin` was tried first and rejected because Chromium still counted the margin.
- After an authorized jump, the reading position was only recomputed by a scroll event. A target already in view therefore left reading disabled and an unread badge uncleared, and a missing target could leave scroll tracking suspended. Jumps now settle on the first committed render and recompute the position explicitly.

`pnpm --filter @tricord/api test:browser` then **passed** on this head with the configured Linux Chromium launcher. The harness's frame assertion was updated to the outline/box-shadow implementation; no assertion threshold or wait was relaxed. `pnpm test:db`, `pnpm test:desktop`, `pnpm test:voice`, image/hosting suites and Windows/physical-device checks were not rerun for this fix.

# Racing-green / stone-gray matte palette — 2026-10-30

Retro now pairs racing-green navigation with a muted stone/blue-gray conversation canvas, rather than the earlier ink or lilac previews. A locally embedded 128×128 SVG supplies fixed monochrome grain to surface backgrounds only; no text overlay, animated noise, external asset request or new dependency is involved. Original and the existing interruptible theme-switch logic are unchanged.

- Inspected the running desktop preview. The actual texture decoded at 128×128 with alpha values **0–7/255**. Contrast measured over the composited grain was at least **7.80:1** for message text and **4.88:1** for timestamps; sidebar-caption contrast against its green surface was **6.21:1**.
- The selected KLIPY tab measured **4.75:1** text contrast. The local provider remained explicitly unconfigured; no provider search was made.
- **390 px and 1440 px** layouts had no document-level overflow. The browser was returned to the standard review viewport. Chat typography remains 15 px / 24 px, and the 120–160 ms motion settings were not changed.
- Changed-file formatting, affected JSX lint, whitespace checks and API health passed. This styling-only revision did not rerun application test suites or full builds; the interaction-regression evidence below remains historical.

# Modern-first appearance and interruptible motion — 2026-10-30

Removed the framed/beveled desktop-window treatment from Retro. Its Y2K references are now restrained green/ice-blue accents and a small asymmetric chrome-like mark on deep-ink surfaces. Replaced conflicting light-theme overrides with a shorter dark token-based theme. Both appearances use 15 px Inter at weight 450 with 24 px line spacing, preserving shared message geometry.

- **219 focused regressions passed across seven files**, including ten appearance persistence/motion cases, existing message/composer/media behavior and KLIPY parser/transport contracts. The first run exposed a stale CSP expectation from the KLIPY addition; the exact four approved KLIPY origins were added to that fixture and only the failing file was rerun. Web typecheck and affected-file ESLint passed. Checks used one worker and a 768 MiB heap cap; no full suite, image build or extra app stack ran.
- Native theme snapshots crossfade for **120/160 ms**, with a cancelable 160 ms opacity fallback. State/preference updates are immediate; obsolete callbacks cannot restore an old theme. Reduced motion and hidden tabs skip animation. Overlays do not intercept interaction.
- In the existing Chromium page, native transition readiness was **29.5 ms** in one observed switch, not a production latency guarantee. Rapid switches retained the same textarea node, focus, typed fixture text and exact timeline scroll position. The empty fixture draft was restored afterward; no message was sent.
- Sampled steady-state text contrast against the actual Retro timeline was **13.33:1** for message text and **7.88:1** for timestamps. Screenshots were inspected. These are targeted observations, not a full assistive-technology audit.
- **390 px and 1440 px** viewports had no document-level horizontal/vertical overflow and the composer remained within bounds. The original viewport was restored. Browser reduced-motion emulation produced zero native theme calls/active theme animations and was then reset to the user's normal preference.

The app remains running with Retro selected. Live KLIPY search still requires the operator's local key; provider account setup and live requests were not performed.

# KLIPY integration and reply-frame correction — 2026-10-30

Added separate GIPHY/KLIPY picker tabs after explicit approval of direct-browser requests/public client keys. Provider configuration remains approved-session-only; the server rejects KLIPY proxy searches. Search uses the fixed KLIPY migration endpoint, documented static media hosts, original queries/URLs and provider order, with bounded JSON/pages/thumbnail dimensions. Switching providers clears results and requires fresh Search consent. GIF messages retain the existing link-only send identity/draft behavior and opt-in preview budget.

- New parser, client transport, configuration/approval/proxy-denial and CDN regressions were added. Automated tests remain **paused at the user's request**; no live provider call was made and the local KLIPY key is not configured.
- The small shared package was compiled to expose the new helpers to the running development app. Web/API typechecks passed sequentially with a 768 MiB heap cap; no full workspace/image build or test suite ran.
- In the shared running browser, KLIPY's tab showed the required `Search KLIPY` placeholder and explicit unconfigured state. API health remained successful. A stale-development-module blank tab was recovered after verifying it contained no app/textarea; existing authentication remained valid.
- Retro's bright canvas was replaced with a dim mist-blue workspace inside a midnight frame. The revised chat screenshot was inspected. Reply selection now uses one padded pseudo-element behind the article, rather than a tight inset frame plus detached marker; avatars/text stay on their shared tracks and reactions remain outside. Original remains selectable.

# Original / Retro appearance preview — 2026-10-30

Added a per-device Original/Retro switch in the left rail and Settings → Appearance. The initial cream/aqua preview was subsequently revised to deep-blue title bars, a clean white conversation canvas and grass-green accents. Retro now includes lightly beveled controls, framed buddy-style avatars, monospace timestamps and an inset composer, not just palette changes. Both themes keep compact message tracks, contextual actions, detached reactions and quick/reduced-motion-aware panels. The preference is validated, applied without navigation, and synchronized through storage events; failed reads/writes produce visible warnings.

- Manually opened the existing app and its Appearance panel, switched Original → Retro, and inspected the chat/settings screenshots. In the initial cream preview, the timeline background changed from `rgb(30, 33, 40)` to `rgb(250, 246, 234)` without leaving the settings panel. The later blue/white/green chat screenshot was also inspected; Original remains charcoal/green. The saved preview choice is Retro.
- At the inspected 696×562 viewport, history and composer fit without document-level horizontal or vertical overflow. Non-hovered mouse action trays remained hidden; message text was 14.5 px. The mobile sidebar now uses a short opacity/transform transition instead of a display snap.
- New preference persistence/error regressions and GIPHY-only picker coverage were added, but automated tests, typechecks, full builds and image checks are **deferred at the user's request until implementation is final**. Existing earlier counts do not validate this preview. Local rollback copies preserve the pre-preview source; no commit/push/deployment was performed.
- Removed the retired Tenor choice from the client without changing the existing server contract or saved message links. GIPHY's existing `pg` rating is unchanged; no replacement provider or account was configured.

# Reply navigation and GIF setup correction — 2026-10-30

Reproduced a successful reply-context response followed by the timeline snapping back to its bottom. Loading temporarily emptied the scroller, whose scroll event incorrectly restored bottom-following. Pending navigation now suppresses that position update until the original is committed and scrolled into view. Opened originals retain a translucent frame; quoted previews have their own compact frame.

- The existing shared browser demonstrated first-click navigation with the original fully visible, and a later independent geometry/style observation confirmed it remained visible and highlighted. No messages were sent or changed.
- `pnpm exec vitest run apps/web/src/message-card.test.ts --maxWorkers=1`: **4 passed**. Affected-file ESLint, web/API typechecks and formatting passed. Typechecks ran sequentially with a 768 MiB Node heap cap. No full suites, production builds or image checks were run for this correction; the expanded fixture browser regression was added but not executed.
- Official provider documentation was checked: GIPHY issues beta API keys with a documented 100-call hourly limit. Google's Tenor FAQ states new integrations closed January 13, 2026 and the API retired June 30, 2026. Setup documentation and the unconfigured Tenor picker now explain this rather than directing operators to obtain a new Tenor key. No live provider search was made.

The normal local app remains running. Earlier interrupted production-build/image attempts are not successful evidence for the latest assets.

# Compact chat headers, not sender columns — 2026-10-30

After confirming the intended Discord/Slack-style direction, removed the reserved sender/table column. Every message now uses a small left avatar, a compact sender header directly above the text, right-aligned time/status icons and a consistent text edge. Reactions remain below and outside the article.

- `pnpm exec vitest run apps/web/src/message-card.test.ts apps/web/src/message-body.test.ts apps/web/src/chat-composer.test.ts`: **37 passed**; lint and the web build passed.
- `pnpm --filter @tricord/api test:browser`: **passed**, checking shared sender/text left edges, compact header-to-body spacing, non-overlapping timestamps and reaction alignment, plus 390-pixel no-overflow behavior and existing chat/notification/media flows.
- Desktop/mobile fixture screenshots were inspected. The UI skill and user guide explicitly prohibit the abandoned reserved-sender-column design. No database/API behavior changed, and the user's app remains running.

# Consistent inline message tracks — 2026-10-30

Replaced the mixed avatar/stacked/grouped-row styling with an isolated message-row layout. Desktop messages use shared avatar, sender, text and timestamp tracks; reactions occupy the text track beneath the article, not its highlight. Every row keeps a compact avatar and sender rather than changing indentation for consecutive authors. Narrow history panes deliberately wrap text below the sender and keep long identities bounded with full-value tooltips.

- `pnpm test`: **270 passed**; focused message/body/composer/state checks: **41 passed**. Lint, web build and API typecheck passed.
- `pnpm --filter @tricord/api test:browser`: **passed** with actual desktop inline-baseline, column non-overlap, fixed reaction geometry/alignment, and 390-pixel no-overflow assertions, plus prior chat/notification/GIF/emoji/drawer regressions.
- Inspected desktop and mobile fixture screenshots. Read-only geometry checks on the shared running page also showed equal sender/text positions across consecutive and non-consecutive rows, with all sampled columns fitting without overlap. Tests and screenshots use disposable fixture content, not copied user conversations.
- Removed the obsolete message-row selectors rather than adding another override layer. The repository UI skill now explicitly requires consistent tracks and protection from generic stylesheet collisions.

No database/API behavior changed in this refinement, so database/image suites were not repeated. The user's local app remains running; no commit, push or deployment was performed.

# Compact messages, responsive drawers and complete emoji — 2026-10-30

Follow-up interactive feedback is implemented: every message retains its sender, consecutive rows no longer reserve hidden-avatar height, reaction pills sit outside the message highlight, and the same pinned button smoothly opens/closes an overlay drawer without resizing history. The left-sidebar Categories control has quick hover/press feedback. GIF-button and `/gif` entry insert links only. The repository UI skill records compact, responsive, reduced-motion-aware interaction standards.

- `pnpm test`: **270 passed** in 46 files; `pnpm test:db`: **112 passed** in seven files. `pnpm typecheck`, `pnpm lint`, the affected web build and changed-file formatting passed.
- `pnpm --filter @tricord/api test:browser`: **passed** with the configured Linux Chromium launcher. A deliberately paused pins request proves the loading shell appears before the response; the final observed first-frame time was **6.6 ms** on this workstation, not a production latency guarantee. The browser observes an actual running drawer transition, verifies repeat-click closure/reopen and inert exit state, unchanged timeline width and reduced-motion behavior.
- Actual message geometry checks confirm one-line consecutive messages with sender names stay within 56 pixels, adjacent gaps stay within 4 pixels, and reaction insertion leaves the article's height unchanged. Detached pills and consecutive text align with the message column. Desktop screenshots were inspected; this also caught/fixed a global stylesheet specificity conflict.
- Full Unicode 17 coverage uses pinned offline `emojibase-data`: **3,953 named entries**, including flags, tones, joined sequences and newer faces. All entries pass server validation and fit the existing database field. Browser search selects a Croatian flag and persists a woman-technologist skin-tone reaction. Popular entries remain immediate; the full catalog is lazy-loaded and no picker page renders over 64 choices. Existing normalized favorite reaction keys remain unchanged. The server preserves a 32-distinct-kind message limit so expanding the catalog does not create unbounded response payloads; retries/existing choices/removal at capacity are tested.
- The final web build emits the optional catalog separately at **85.91 kB gzip**, with the main application chunk **119.70 kB gzip**. Both the pre-existing LiveKit and the optional raw catalog chunk exceed the bundler's 500 kB advisory; the catalog is not part of initial chat loading and never calls an external emoji service.
- Browser checks cover both the composer GIF button and `/gif`, draft-preserving cancellation, plain-link insertion and **zero media requests before preview consent**. Existing decoded-frame play/pause, membership, unread, notification and two-tab checks also pass.
- The Dockerfile build (host networking) and `pnpm test:server-image` **passed**, covering packaging of the new offline dependency and disposable backup/restore. No new schema migration is required. UI skill metadata/name/path and relative links were validated; instructions/discovery links point to the canonical skill.

The existing local app/services remain running; no user database/profile was reset. Checks use owned disposable databases/profiles. Windows-native, physical audio and assistive-technology certification remain separate from this local evidence. No ticket, commit, push or deployment was performed.

# Chat interaction and layout refinement — 2026-10-30

Follow-up to interactive UX feedback; no persistence, API permissions or notification-delivery policy changed.

- `pnpm test`: **265 tests passed** in 43 files. Regressions cover self-inclusive bounded autocomplete, an enabled composer during pending delivery, inline emoji placement, hidden action rows, settings-only notification controls and one-time setup preferences. Existing legacy popup opt-in and sound-off defaults remain covered.
- `pnpm typecheck`, `pnpm lint` and `pnpm --filter @tricord/web build`: **passed**; the existing LiveKit bundle-size advisory remains.
- `pnpm --filter @tricord/api typecheck` and `pnpm --filter @tricord/api test:browser`: **passed** using the configured Linux Chromium launcher. Actual flows open message actions by right-click, navigate them with Shift+F10/arrows/Escape, add/remove reactions without a second picker trigger, preserve composer focus after sends, insert/highlight a self mention while persisting zero self recipients, and retain prior thread/pin/media/privacy assertions.
- The browser verifies the automatic setup invitation opens **Settings → Notifications** without enabling alerts. Closing settings leaves notification delivery active; subsequent two-tab deduplication, popup/sound/mute/priority and public-reply navigation checks pass. Notification controls are absent from the sidebar; the 390-pixel settings panel has no horizontal overflow.
- Desktop-width chat/menu and desktop/mobile notification screenshots were visually inspected. Metadata is right-aligned, actions are contextual, the smile control sits within the compact composer, and category management has a visible sidebar label plus links in channel forms. These are local Chromium observations, not Windows/native-banner or assistive-technology certification.

The user's existing local app and Docker services remain running. Browser checks use owned disposable databases/profiles, not the user's account or messages. No ticket, commit, push or deployment was performed.

# Coordinated chat modernization — 2026-10-30

The remaining chat scope is implemented on `feature/chat-improvements`: canonical replies/single-level threads, authorized pins/context jumps, persisted Unicode reactions and resolved mentions, private alert rules, independent popup/sound controls, coordinated tabs, consent-gated native GIF playback and account-scoped in-memory drafts/identity UI. This is implementation/local evidence, not ticket completion, Windows certification or deployment authorization.

- Final local suites: `pnpm test` **passed 261 tests** in 41 files; `pnpm test:db` **passed 110 tests** in seven files. Lint, workspace types and production builds passed. Changed-file formatting is checked separately.
- Database verification covers reference/item/count visibility across membership gaps, unavailable/deleted roots, canonical ordering, reply-aware and legacy idempotency, concurrent pin/reaction retries, author-only edits, archives, CSRF/origin, exact Unicode-aware mention boundaries and account-private preferences. Hydration uses **five queries for either one or 50 messages**, rather than per-item queries.
- Migration verification: the disposable upgrade fixture starts at 0000–0004, preserves original messages/read progress and earlier journal entries through 0005–0007, retains historical recipients for a suspended account and supports legacy ASCII writes/repeated startup. `pnpm db:generate` reports no schema drift. Existing applied SQL was not rewritten.
- `pnpm --filter @tricord/api test:browser` **passed** with the configured Linux Chromium launcher. Actual UI checks include replies/reply-to-reply, thread reads leaving the parent cursor unchanged, pin jumps beyond the loaded page, reaction add/remove, canonical autocomplete, draft switching/reload clearing and prior channel/auth/unread flows.
- Native GIF evidence uses an intercepted, generated two-frame fixture, **not a live CDN request**: zero requests before consent; one bounded fetch after consent; actual canvas pixels change while playing and remain unchanged over 15 animation frames while paused. Stop resets/hides the canvas and leaves the original link usable.
- Two actual authenticated browser documents receive the same notice over their sockets and **one** popup adapter is invoked through real Web Locks. This exposed and fixed a dead-page ownership bug after reload: lifetime document locks now exclude stale peers instead of losing one-shot alerts. OS popups are mocked; no real desktop banner is claimed.
- Browser sound evidence uses the native `AudioContext` with an explicit user gesture and observes scheduled oscillator starts; volume `0.25` persists. Conversation mute and sender mute/priority suppress both deliveries without suppressing unread badges. A public reply without an @mention produces an in-app toast plus one sound, not an OS popup; opening it navigates to the authorized thread without acknowledging unseen timeline messages. Global disable still overrides priority. This does **not** certify physical audio output or OS denial behavior.
- Final regressions distinguish transient delivery outages from lost access: a failed delivery reports unavailability without evicting the subscribed room or discarding drafts; original-history authorization failures clear dependent private views. Actual viewport resizing followed by a new arrival leaves scroll position/read progress unchanged until explicit latest navigation. Latest reloads also scroll correctly when the replacement page has the same item count.
- `pnpm --filter @tricord/desktop test:links` **passed** in real Electron after rebuilding: renderer isolation, unsafe destinations, untrusted origin and popup denial remain intact; external OS launches use a recording adapter. The authenticated desktop smoke remains **blocked on Linux by its existing Windows-only platform assertion**. Windows native banners, permission/Do Not Disturb behavior, physical sound and assistive-technology/touch checks remain manual gates.
- The production image smoke now creates and restores replies, unique pins/reactions, resolved mentions and private conversation/sender preferences in addition to original read progress. `pnpm test:server-image` **passed**, including repeated migrations, non-root runtime, readiness and disposable backup/restore. Dockerfile builds used host networking because the default build network previously timed out downloading dependencies.

All data-bearing checks use owned disposable databases/profiles and generated ignored credentials. No real messages/media, secrets, tickets, pushes or production operations were involved. The existing LiveKit bundle-size advisory remains; native GIF decoding adds no codec dependency.

# Channel metadata and categories — 2026-10-30

First implementation slice of chat modernization (AC1), not completion of the coordinated ticket. Approved defaults are implemented: Unicode channel/category names, normalized uniqueness, optional topics, shared ordering, revision-fenced edits and non-destructive category removal. No ticket, push, release or production deployment was performed.

- `pnpm test`: **170 tests passed** across 30 files.
- `pnpm test:db`: **97 tests passed** across five files. New coverage includes concurrent normalized duplicates, stale edits/reorders, category pagination, archive restrictions, session/approval/CSRF/origin checks, category-removal invalidation and preserved message IDs/read cursors.
- The upgrade regression applies migrations 0000–0004 to an isolated database, inserts existing chat/read data, applies 0005 and verifies that data and prior journal entries survive. Legacy ASCII channel inserts/renames remain compatible; repeated migration execution is unchanged. `pnpm db:generate` reports no schema drift.
- `pnpm --filter @tricord/api test:browser`: **passed** with Linux Chromium selected through `TRICORD_BROWSER_PATH`. The local launcher used `--disable-dev-shm-usage` after the default shared-memory launch stalled. New actual UI assertions cover category create/rename/removal, Unicode names/topics/order, reload persistence, stale edits retaining local text, archive/restore, keyboard focus containment/restoration and a 390-pixel dialog without horizontal overflow. Existing authentication/chat/unread/notification flows also passed; OS notification delivery remains mocked. Linux screenshot fonts do not certify emoji appearance on Windows.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and the final affected web build: **passed**. The existing LiveKit chunk-size advisory remains.
- `pnpm server:build` initially failed during registry downloads. Retrying the unchanged Dockerfile with `docker build --network=host -f infrastructure/server/Dockerfile -t tricord-server:alpha .` **passed**. `pnpm test:server-image` **passed**, including non-root runtime, repeated migrations, static assets, readiness and disposable backup/restore with read progress.
- `pnpm --filter @tricord/api test:desktop --chat-only`: **blocked on Linux** by the existing smoke assertion requiring `window.tricordDesktop.platform === 'win32'`, before authenticated chat checks. Electron launched; retrying with the shared-memory-safe launcher reached the same assertion. No sandbox/IPC checks were weakened, and no Windows/OS notification evidence is claimed.

Local checks used newly generated ignored credentials, loopback-only PostgreSQL/LiveKit and owned disposable databases/profiles. Existing database data, credentials and Docker volumes were preserved.

## CI/CD completion audit — 2026-10-30

Prepared `feature/ci-cd-completion` from freshly fetched `develop` at `264fcc7409c8f776819ba70abb60bfe877434a96`. The Verify workflow now rejects PRs outside `feature/*` or `dependabot/*` into `develop`, and same-repository `develop` into `main`, including base edits. Dependabot version updates target `develop`; default-branch security updates need retargeting. No publication/deployment conditions, registry identities, operator scripts or production settings changed.

Read-only GitHub audit:

- The existing develop commit passed [Linux Verify](https://github.com/Treca-Raja/rajcord-public/actions/runs/40954328870) and [Windows desktop](https://github.com/Treca-Raja/rajcord-public/actions/runs/40954329068). These are baseline runs, not CI evidence for this unpushed change. Their check names are `verify` and `build`, both from GitHub Actions app `15368`.
- `develop` enforces administrator/PR review rules but has no required status checks. `main` requires up-to-date `verify`, one approving review, administrator enforcement and blocks force pushes/deletion; it is also locked. The active main ruleset blocks deletion and non-fast-forward pushes with no bypass actors. Proposed setup: require up-to-date `verify` and `build` from app `15368` on both branches, preserving other protections and the main lock. Remote configuration remains separately authorized work.
- `HOSTING_ENABLED=true`. Production has a required reviewer, administrator bypass disabled and exactly one `main` branch policy. The expected deployment variable and secret names exist; values/credentials and actual host access were not tested. The old runbook's disabled/pending statements were removed rather than presented as live facts.
- `main` remains `613b367edf2671345fc55ed3029523905c1add2a`; its earlier [successful Verify dispatch](https://github.com/Treca-Raja/rajcord-public/actions/runs/40574541747) does not verify develop's newer source/registry policy. New GHCR write/pull access, saved image markers and rollback compatibility remain release gates. The `desktop-release` environment is absent; desktop publication remains blocked pending separately authorized setup. No workflow was dispatched or production host accessed during this audit.

Local Node 24.20.0 / pnpm 11.25.0 verification: `pnpm exec vitest run scripts/pr-policy.test.ts scripts/release-policy.test.ts scripts/desktop-release-policy.test.ts` passed all 30 tests; `pnpm lint` and `pnpm typecheck` passed. Both workflows passed the same pinned actionlint 1.7.12 container used in CI, with a read-only source mount and no container network. Changed-file formatting, relative links and whitespace checks passed. Dependencies were synchronized offline with the frozen lockfile; no dependency versions changed.

No application, database, image, hosted-stack, Windows packaging or physical-device suites were rerun: this change affects PR routing, dependency-update targeting and documentation, not those runtimes. Existing exact-main, immutable-image, publish-only and environment approval behavior is covered by the focused release regressions. The initial audit performed no commit, push, PR, merge, remote settings/Trello write, publication or deployment.

Following explicit maintainer approval, configured up-to-date `verify` and `build` checks from GitHub Actions app `15368` on both `develop` and `main`. Independent API readback confirmed the exact checks and compared the remaining branch-protection objects against their saved pre-change values: review requirements, administrator enforcement, force-push/deletion restrictions and branch locks are unchanged. The active main ruleset was also read back unchanged, with no bypass actors. Main remains locked; no merge, production environment change, release or deployment was authorized or performed.

## Opt-in application sounds — 2026-10-30

Implemented on `feature/application-sounds` from refreshed develop `264fcc7409c8f776819ba70abb60bfe877434a96`. Sidebar controls independently enable sound, set volume (initially 35%) and preview a cue; sounds start off. Preferences are account-scoped on the current browser/device. The existing private-message/mention eligibility and bounded message-ID deduplication are reused without new notification events or backend policies.

Sounds route to the exact speakers selected in Audio controls, including outside a call. Missing/unsupported/denied output never falls back to a default device. Deafen, disabling, output changes and logout stop active or pending playback. Three short locally generated PCM tones use Blob URLs permitted by the existing CSP; URLs are revoked on disposal. The initial data-URL implementation failed real playback under CSP and was replaced without weakening the policy. Playback errors are visible, Preview retries explicitly, and missed/burst events are not queued or replayed (300 ms coalescing).

Voice cues cover successful local join/leave and live peer membership changes in the current room. Initial and reconnect rosters do not replay. Live testing exposed SDK peer cleanup preceding its reconnect event; participant updates now coalesce within that SDK turn, signal reconnect is represented explicitly, and connected state is published with its authoritative roster. Regressions cover this ordering and stale playback after output changes/logout.

Windows Node 24.20.0 / pnpm 11.25.0 verification:

- `pnpm test`: 176 unit/regression tests across 28 files passed. An earlier full run hit the existing development-reload test's transient `ECONNREFUSED`; its focused rerun and subsequent complete runs passed. The final sound file has 11 cases, with existing notification and voice regression coverage retained.
- `pnpm test:db`: 88 tests passed using disposable databases; existing development data and volumes were preserved.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, changed-file formatting, documentation links and whitespace checks passed. The existing lazy LiveKit chunk-size advisory remains non-failing.
- `pnpm --filter @tricord/api test:browser`: 38 real Edge checks passed, including popup/sound independence, exact output/volume, eligible live message delivery and retry deduplication, focused suppression, denied playback/recovery, stored preferences after actual reload, keyboard access and sidebar layout. Playback and routing use the browser's media implementation; OS popups and the explicit playback-denial case are controlled adapters. The reload harness now waits for a new document rather than accepting the old page's controls. Expanded-controls and wide/narrow synthetic-fixture screenshots were inspected.
- `pnpm --filter @tricord/api test:desktop`: 29 Electron checks passed across three launches, including real selected-sink preview, opt-in, deafen suppression, existing microphone/permission checks, notifications and session lifecycle. The harness allows only the sound-preference object shape in localStorage rather than incorrectly treating permitted preferences as authentication tokens. Failed Electron runs now surface their original error before reporting a missing result file.
- `pnpm --filter @tricord/api test:voice`: 20 checks passed with two independent sessions, live leave/rejoin sounds, no mid-call history or signaling-reconnect replay, existing exact-device behavior and API restart/revocation cleanup.
- `pnpm --filter @tricord/api test:voice:load`: ten synthetic clients passed a 65-second ten-way audio soak with production rate limits, eleventh-user rejection, simultaneous signaling recovery, API restart and cleanup. This remains a single-Windows-host/loopback check, not WAN or physical-headset evidence.

After testing candidate `20ff2b4e04daf8764abad1b146815147c9ed441d` locally, the maintainer reported that the supplied manual checklist “all worked” on 2026-10-30. The checklist covered selected headset devices, opt-in, preview/volume, local join/leave, deafen and disabled-sound suppression, with second-account peer/message checks also provided. This is maintainer-reported local acceptance; no separate hardware inventory or per-case measurements were supplied.

Test-owned accounts, profiles, databases and media rooms were used for automation. Local services stayed on loopback. No authentication/session or Electron isolation/permission boundary, database schema, service credential, default device, CSP, registry or production setting was changed. No merge, release or deployment was performed. Independent OS mixer/device certification, WAN devices and installed/signed-release acceptance remain unverified. Cooperation between separate tabs and richer per-conversation/reply/priority notification policies remain chat-modernization scope.

# Authenticated hyperlink verification — 2026-10-28

Windows verification on `feature/chat-hyperlinks` after `a11e3be`. Installed Docker was confirmed running Linux containers. Existing setup commands generated ignored local credentials without printing them; loopback-only PostgreSQL/LiveKit started and additive migrations applied. Test suites used disposable databases and isolated Edge/Electron profiles. Existing data and volumes were preserved.

- **113 unit/regression tests passed** (`pnpm test`).
- **65 authentication/chat database tests passed** (`pnpm exec vitest run --config vitest.database.config.ts apps/api/src/chat/chat.integration.test.ts apps/api/src/auth/auth.integration.test.ts`). Unrelated voice/database suites were not selected.
- **31 Edge checks passed** (`pnpm --filter @tricord/api test:browser`): 11 authentication and 20 messaging/unread/notification checks. Hyperlinks were verified after sending, reloading stored history, receiving another account's message and editing. HTML remained escaped and unsafe Markdown destinations stayed literal.
- **21 authenticated Electron checks passed across three launches** (`pnpm --filter @tricord/api test:desktop --chat-only`). Added explicit autolink/Markdown-link assertions for sent, received and restored messages, including new-tab/security attributes and normalized destination titles. The new chat-only mode skips camera, microphone and voice checks; the default combined suite remains available.
- The isolated real Electron window-open smoke passed (`pnpm --filter @tricord/desktop test:links`), with OS launches recorded rather than actually opening a system browser.
- `pnpm lint`, `pnpm build` and formatting checks passed; only the known LiveKit chunk-size advisory remains. TypeScript compilation covered both updated harnesses.

This closes the earlier authenticated chat verification gap. No microphone capture, voice joins, audio publication, voice/load tests, server-image tests or production changes were needed or performed. LiveKit was only a prerequisite of the existing chat harnesses. The actual default-browser application launch remains outside the recording-adapter check.

# Chat hyperlink review fixes — 2026-10-28

Addressed PR #9 feedback on `feature/chat-hyperlinks`. The reported duplicate-message failure was a misreading of removed/added lines; the browser smoke now selects the persisted message by ID to remove text-match ambiguity. Sequential smoke operations remain sequential because their UI and server state depend on earlier steps.

Automatic links exclude paired emphasis without stripping legitimate unpaired URL characters. Anchors expose the normalized destination in `title` and have an explicit keyboard focus outline. Markdown destinations use a balanced scan; unsupported titles, whitespace and incomplete destinations remain literal. Label matching no longer rescans repeated opening brackets; maximum-length hostile bracket cases are tested. The API already limits message bodies to 4,000 characters.

- Full `pnpm test`: **113 tests passed in 20 files**, including 30 additional review regressions (16 parser/rendering and 14 Electron handler cases).
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed; only the known LiveKit chunk-size advisory remains.
- Real Electron `pnpm --filter @tricord/desktop test:links`: passed on Windows with a separate profile, sandbox/context isolation and renderer Node disabled. Actual renderer-created window-open events delegate valid HTTPS to a recording OS adapter; unsafe destinations and an untrusted app-page origin cause no external action or additional window. Unit cases also cover HTTP, malformed URLs, credentials, origin/port mismatches and rejected OS launches. The smoke script clears the inherited `ELECTRON_RUN_AS_NODE` flag.
- The system default browser itself is not launched by this smoke. Authenticated Edge chat, database integration and the full authenticated Electron smoke remain unrun because local PostgreSQL/LiveKit configuration and Docker are absent.

# Chat hyperlinks — 2026-10-27

Feature branch: `feature/chat-hyperlinks`, based on `origin/main` at `613b367`. Shared React rendering adds HTTP(S) autolinks and simple Markdown links without changing stored text or API behavior. Electron delegates validated HTTP(S) links to the default browser and continues denying new renderer windows and navigation. No dependencies added.

- `pnpm test`: **83 tests passed in 19 files**, including 18 new parser, escaped-rendering and shared URL validation cases. The initial sandbox run failed four existing Windows process startup/cleanup checks; the complete rerun outside the sandbox passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed. The existing lazy LiveKit chunk-size advisory remains.
- `pnpm format:check`: flags 123 untouched files in this Windows checkout, where `core.autocrlf=true` gives them CRLF line endings. Changed files pass the default Prettier check; `pnpm exec prettier --check . --end-of-line auto` passes for the entire checkout. Unrelated files were preserved.
- Database integration, Edge authenticated messaging and Electron runtime smokes were not run: Docker and local PostgreSQL/LiveKit configuration are absent. The browser smoke now contains assertions for sent, reloaded, received and edited hyperlinks, but those new assertions have not been executed here. Actual external-browser launches remain unverified.

Only explicit HTTP(S) URLs without credentials are linked. Common trailing punctuation and excess closing brackets are excluded. Markdown support is limited to simple labeled links; backtick code spans/fences, HTML and image syntax remain literal. There is no full Markdown renderer.

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

## Rajcord Windows distribution — 2026-10-28

Implementation on `feat/rajcord-windows-distribution`, based on the existing Electron client. No release, push, merge, remote environment change or production infrastructure mutation was performed. Earlier local hosting documentation changes were preserved.

Completed checks:

- Workspace formatting, ESLint, TypeScript and production builds passed. Vitest: 75 unit/regression tests across 21 files. The first development-reload test run hit ECONNRESET; its focused rerun and subsequent complete runs passed. The known lazy LiveKit chunk advisory remains non-failing.
- PostgreSQL integration: 88 tests passed. Electron: 26 authentication/messaging/synthetic voice/notification/lifecycle checks across three launches. Edge: 30 auth/messaging/unread/notification checks. Two-browser synthetic voice: 17 checks passed. These runtime smokes exercised the existing unpackaged Electron/browser paths with the updated main/preload code, not authenticated production accounts in the installed application.
- Windows excluded TCP ranges covered the default local 7880/7881 ports. The existing LiveKit container could not restore its published bindings after Docker startup; its initial integration attempt failed readiness. A disposable `rajcord-distribution-test` loopback fixture on 17880/17881/17882, with the existing credentials supplied privately, passed the preflight and all runtime suites. No Windows exclusions, credentials or tracked default port configuration were changed. The disposable fixture was stopped after testing; the default LiveKit service remains unavailable until its reserved-port conflict is resolved.
- `pnpm desktop:package` built the unsigned Windows x64 NSIS installer; `pnpm desktop:audit` passed identity, archive-content and disabled unsigned-update-feed checks. Original SVG/PNG/multi-resolution ICO resources are generated by the dependency-free icon script. Installer/executable metadata uses Rajcord 0.1.0 (Windows product version 0.1.0.0).
- Actual per-user NSIS installation/uninstallation passed in `.local/desktop-install`, including Desktop/Start Menu shortcut targets and registration removal. The installed client reached the anonymous `https://rajcord.com` sign-in page despite inherited development/remote URL overrides; renderer Node isolation, preload version and secure WebRTC/media API availability passed. It did not sign in, open a microphone or mutate production data. The fixture terminates only its owned test process; it does not certify native tray/Quit/OS-shutdown behavior. Its marked `%APPDATA%\Rajcord` test profile was retained and must not be used for personal accounts.
- Real Windows signature verification accepted an embedded, Windows-trusted system-executable signature and rejected the unsigned Rajcord executable. An OS catalog-signed fixture was correctly rejected. PowerShell progress output initially prevented a valid result; progress is now suppressed while errors/warnings still fail closed. Regression tests cover unavailable PowerShell/malformed output, wrong publisher/path/type, missing trust configuration, consent, cached-file signature failure and replacement even by a trusted signed file. Actual Rajcord signing and update installation were not exercised.
- `pnpm audit --prod` passed after replacing the added older YAML parser and pinning the updater's transitive copy to patched 4.3.2. Both workflow files passed pinned actionlint 1.7.12. The Windows workflow has not been run on GitHub; remote protected-environment policy and real signing credentials remain unconfigured.

Remaining release gates: interactive Windows installer/UI/SmartScreen behavior; tray/second-instance/native Quit and shutdown; installed authenticated messaging and notification clicks; physical exact microphone/speaker devices, listening quality and cross-network/TURN voice; and detection/download/restart installation between two explicitly authorized signed test releases. No certificate or GitHub test release was created. Unsigned first releases deliberately support manual replacement only. See [the distribution runbook](desktop-distribution.md) for commands, security/version constraints, signing setup and the draft-only release process.

## PR #11 review corrections — 2026-10-29

Prepared local fixes on `feature/rajcord-windows-distribution` for [the review comment](https://github.com/Treca-Raja/rajcord-public/pull/11#issuecomment-6483003787). Existing naming, hosting and Codex-configuration work was preserved. The proposed PR title is `feature/rajcord-windows-distribution`, targeting `develop`; no PR metadata or remote settings were changed.

The LF attribute rule was validated in a disposable Windows clone with `core.autocrlf=true`: the original checkout reproduced the exact 144-file Prettier failure, while a fresh checkout with the candidate attributes passed. All 11 tracked migration SQL/metadata files and both PNG/ICO assets matched their original Git bytes. No applied migration, journal or binary resource was rewritten. Windows review builds now include pushes to `develop` and `main`; release jobs still require explicit dispatch, current main, protected-environment approval and exact-version confirmation.

Existing local desktop configuration already selected `Treca-Raja/rajcord-public`; it was preserved and covered by 19 new mocked desktop release-policy regressions. They accept the canonical repository and reject former/unapproved repositories, develop/feature/tag/PR refs, invalid version/SHA confirmations, superseded main, API failures, missing reviewer/no-bypass protection, non-exact branch policies, and missing exact-commit/main/push successful Verify evidence. No real GitHub policy API, token, signing credential or release was used by these tests.

Updater recovery now releases the operation guard with `finally`, reports preparation/installer failures and supports verified retries. The small `RecoverableNsisUpdater` extension retains default Electron HTTP initialization and the pinned v6 public installation flags/native event contract. Failed/stale attempts cannot execute their already queued quit; the next attempt gets a fresh updater and rechecks/reverifies its cached download. The main process restores its ordinary lifecycle flag on failure. Fault injection covers cleanup rejection, dialog rejection, synchronous launcher errors, asynchronous errors followed by queued quit, refused installation and fresh retry. An independent read-only review found and prompted correction of the queued-quit race, then reported no remaining actionable findings.

Verification completed:

- Isolated review candidate: independent offline frozen-lockfile install, clean production dependency audit, formatting, ESLint, all workspace type checks, **100 tests across 23 files**, all workspace builds, Windows x64 NSIS packaging and package audit passed. This executes the local build/check/package sequence corresponding to the Windows job; it does not execute hosted checkout/setup/upload actions or establish a GitHub Actions result.
- Current working tree: ESLint/typecheck and all builds passed, followed by **112 tests across 23 files** and the existing **26-check Electron smoke across three launches** using ready loopback PostgreSQL/LiveKit fixtures. An initial full-suite development-reload test hit a transient connection refusal; its focused rerun and the subsequent full suite passed. The known lazy LiveKit chunk advisory remains non-failing.
- Pinned actionlint 1.7.12 passed for both workflows. Task-file formatting and whitespace checks passed. Whole-tree formatting still flags only the five pre-existing untracked `.github/agents/*.agent.md` files, which were not reformatted or absorbed into this change.

The hosted Windows job has not been rerun because these corrections have not been committed/pushed. Installation/uninstallation, real signed updater launch/recovery after shutdown, two signed releases, and physical/WAN voice were not rerun; the distribution runbook retains those acceptance gates. No commit, push, merge, PR comment, PR title/base change, workflow dispatch, release publication, production access or deployment was performed.

## Agent workflows and organization transfer - 2026-10-28

Documented `feature/* -> develop -> main` in the agent guidelines, contributor workflow, PR template and release runbook. Added planning, documentation and future deployment-option skills, with shared Copilot/Codex discovery guidance. Existing verification and hosting skills now clarify local regression tests, minimal code comments, compatibility checks and pipeline boundaries. Per-component deployment switches remain unimplemented, and no GitHub branch protection settings were changed.

Updated current repository/community links to Treca-Raja and migrated the publishing tag and release-policy allowlist to `ghcr.io/treca-raja/tricord-public`. Six focused release-policy tests pass, covering organization casing, rejection of the former owner/image namespace, invalid repository input, feature/develop release rejection before network access, current-main checks and production approvals. Mocked GitHub requests target the new organization. Publication, publish-only and production approval gates remain unchanged.

Validation used the locked pnpm toolchain in a local Node 24 Linux container, with network disabled during tests. Focused ESLint checks, workspace type checks and the shared-package build pass. The workflow passes the pinned actionlint 1.7.12 validator. All seven skill manifests, changed-document local links and command references validate; changed-file formatting and whitespace checks pass.

No database, browser, Electron, voice or image/hosting smokes were run for these guidance and release-identity changes. Earlier application evidence remains separately dated. No source push, workflow dispatch, image publication or deployment occurred. Organization package access, host pull credentials and post-transfer production settings still need verification before an authorized release.

## Ticket guidance and personal Trello MCP - 2026-10-28

Added a canonical ticket template and a ticket-writing skill for AI-created Trello cards and GitHub issues. Root instructions, the skill index, contributor guidance and the planning skill reference it. The format separates scope, requirements, acceptance criteria, testing, completion and delivery metadata; drafting does not imply tests passed or work was approved.

Verified the official Trello MCP endpoint and documented OAuth setup with personal configuration rather than repository credentials. Personal board routing stays outside tracked project files. The endpoint returned HTTP 401 without credentials, which establishes reachability, not authorized access. Authenticated board/list access and card creation were not verified in this session because its tool list did not expose the newly configured server.

Local checks cover the eight repository skill manifests, the personal routing manifest, JSON structure, template sections/metadata, relative links, formatting and whitespace. No application runtime changes, tests, Trello cards, repository commits or pushes were made for this documentation/configuration update.

## Progressive guidance loading - 2026-10-28

Removed mandatory upfront reads of the skill index and project memory. Root instructions now direct targeted source reads and task/phase-specific skills; routine fixes do not trigger planning/ticket/documentation chains. Shortened all eight skill bodies, retained the ticket template and safety/release boundaries, and moved repeated operational detail back to its existing runbooks. Local checks remain impact-based, with wider coverage when needed.

Measured Unicode character counts: root instructions decreased from 8,481 to 5,176 (39.0%); default required reading decreased from 26,697 to 5,176 (80.6%, excluding optional task-specific reads). The corresponding default word count decreased from 3,352 to 648. Skill bodies decreased from 32,978 to 18,481 characters (44.0%). These are source-text measurements, not actual model-token counts or a response-time benchmark; discovery metadata, source code, tool results and conversation history still add context.

Validated eight manifests, 49 local links, 37 executable root-command references, formatting, whitespace and retained critical instructions. No application/runtime tests were needed for this guidance-only change. Historical memory and staged changes were preserved; no model, MCP, application, release configuration or remote state was changed.

## Rajcord repository and guidance rename - 2026-10-29

Updated current repository/community links, the workspace filename, eight skill names/directories and their references to Rajcord. Personal Trello routing was renamed outside the repository without changing the board or credentials. The local checkout and origin now use rajcord-public; the feature branch remains unchanged for PR #12. Historical verification/milestone records retain the original names.

Publishing, CI release policy and the server-side image validator now agree on `ghcr.io/treca-raja/rajcord-public`. Fixed the operator helper's remaining former-owner allowlist and bootstrap placeholder. Tests reject mutable tags, both previous image namespaces and unrelated repositories before deployment operations, while preserving the previous successful release marker.

Ten release-policy/hosting-configuration tests pass in an offline Node 24 container. The existing operator fixture passes in a disposable, networkless Linux container without a Docker socket, including bootstrap image selection and backup/migration/HTTPS failure paths. Focused ESLint, strict TypeScript checking of the changed release tests, pinned actionlint 1.7.12, ShellCheck 0.11.0, skill metadata/link checks, changed-file formatting and whitespace checks pass.

No application/package names, environment variables, database/volume/cookie identifiers, server paths, systemd units or backup tags were migrated. No full application build, hosted TLS/media smoke, Windows packaging, registry publication or deployment was performed. Before an authorized release, verify new package permissions, host pull access, saved image markers and rollback digests; former-namespace images are now rejected. No commit, push or PR merge was performed.

## PR #11 integration with develop - 2026-10-29

Reconciled desktop branch `2c1b4c9` with develop `f046911` in an isolated worktree. The merge retains the optimized Rajcord skills, ticket template, branch flow and canonical server release namespace alongside Windows packaging, tray lifecycle and verified-update recovery. Both `package:win` and the develop branch's `test:links` script remain in the desktop manifest. The merged main process retains validated external-link handling as well as updater/lifecycle behavior. Both branches' dated verification history is preserved.

Local validation in a network-disabled Node 24 Linux container passed all workspace builds and type checks, repository-wide formatting and ESLint, and **149 tests across 26 files**. This includes the external-link/message-rendering regressions, updater failure/retry tests, and separate server/desktop release policies. Both workflow files pass pinned actionlint 1.7.12. The frozen lockfile restored without changes and the known lazy LiveKit chunk-size advisory remains non-failing.

Windows NSIS packaging, installer/signature checks, real Electron/browser smokes, database integration and physical/WAN voice were not rerun in this Linux resolution environment. The Windows workflow and distribution runbook retain those acceptance gates. No production services, release assets, credentials, remote protection settings or persistent data were changed.

## Integrated Rajcord naming - 2026-10-29

Prepared the naming ticket in an isolated worktree and rebased onto develop `3bf4071` after PR #11 merged during verification, preserving the original dirty checkout. PR #12 supplies guidance/source/registry identities and PR #11 supplies native desktop branding/distribution; both are inherited without duplication alongside the hyperlink feature. This change adds remaining shared UI/API/development branding and the [naming inventory](naming.md). Unrelated local hosting/Codex changes are excluded.

An independent offline frozen-lockfile install, whole-repository formatting, ESLint, all workspace type checks, 149 unit/regression tests across 26 files and all workspace builds passed with Node 24.20.0 / pnpm 11.25.0. The known lazy LiveKit chunk-size advisory remains non-failing. Existing release-policy tests pass against develop's canonical source/image identities; no workflow, validator or registry migration behavior was changed here.

Built-code smokes passed against the existing loopback PostgreSQL/LiveKit services with disposable test accounts, databases and profiles: 31 headless Edge checks and 27 Electron checks across three launches, including the merged hyperlink behavior. Electron setup first installed the worktree's pinned binary before the rebase. Subsequent native-notification setup rejected that binary's different path against the existing Windows shortcut identity; the successful run used the already registered Electron 45.0.0 binary after verifying its SHA-256 matched the isolated binary. The original notification shortcut was restored byte-for-byte. A temporary diagnostic change was restored and is absent from the diff. No development data, credentials, profiles or Docker volumes were reset.

Independent read-only review found no actionable issue. Local documentation links and whitespace were checked. No database/schema migration, installed/signing/update acceptance, physical-device/WAN validation, server-image/hosted TLS smoke, registry access/publication, remote setting change or production operation was performed. Image/hosted smoke title assertions were updated to match the web page; those Docker suites were not rerun because image/service behavior is unchanged. Former registry images/markers still require a separately verified recovery path before release; source configuration is not package access or runtime migration evidence.

## Desktop package exclusions - 2026-10-29

Reproduced PR #6's Windows archive audit failure against develop: the archive contained `node_modules/@tricord/shared/dist/http-url.test.js` and `dist/external-links-smoke.js`. The existing exclusions covered only desktop `*.test.js` files and the single `dist/smoke.js` entry. This was a real packaging-exclusion failure, not a random test failure or evidence of packaged credentials.

Packaging now excludes compiled tests and smoke scripts throughout the desktop archive, including production workspace dependencies. The private/test/server audit remains enabled and reports rejected archive paths. Four regression cases failed with the original configuration; all 14 packaging cases and 19 desktop release-policy cases pass with the correction. Changed-file formatting, focused ESLint, desktop type checking and all workspace builds also passed locally.

Rebuilt the Windows x64 archive on Linux with executable-resource editing disabled only for that local cross-build. Its 327 entries contain no audit-rejected paths, and seven checks retain the main/preload, external-link, updater and shared runtime files. The full NSIS cross-build failed in Linux `makensis` with `stack smashing detected`; consequently the complete package audit still fails on the missing installer. This is not a native Windows installer/signing/install test. The standard Windows CI package/audit remains required before merging; no audit, release or review gate was disabled.

## Live member availability — 2026-10-30

Local implementation for Trello card `9OYwPMaW` on `feature/live-member-presence`, preserving the pre-existing dirty checkout. The initial evidence below was collected before publication. No database migration, production access, Trello write or deployment occurred.

Approved timing contract: Socket.IO ping interval 25,000 ms and timeout 20,000 ms; reconnect grace 5,000 ms, not extended by duplicate stale disconnects. Worst-case undetected network loss is approximately 50 seconds including grace. Known HTTP logout/session revocation/suspension/removal bypass grace, with account mutation response hooks reconciling presence. The existing 15-second periodic session authorization check remains; delivery/snapshot sources and recipients are freshly authorized. Healthy local propagation/snapshot target and client snapshot timeout are 5,000 ms. Client recovery permits two automatic attempts, spaced by two seconds, then explicit retry; a new server recovery epoch allows synchronization again. Presence snapshots have a separate 12-per-minute per-socket budget; ordinary chat/API limits remain unchanged.

Completed automated checks:

- `pnpm test`: 124 tests across 25 files, including seven server presence tests with controlled timers and five client state/grouping tests. Covers multi-connection aggregation, bounded grace/reconnection/stale disconnects, authorization loss during grace, pending/revoked delivery, database uncertainty/recovery epochs, snapshot budgets/revisions, obsolete/gapped deltas, sorting and distinct counts. One development watcher test initially hit connection refusal during concurrent source edits; the subsequent complete suite passed.
- `pnpm test:db`: 89 tests across five files. The new real Socket.IO/PostgreSQL scenario connects ten approved accounts with twenty connections, verifies distinct snapshots, nine additional Online changes and no more than ten deltas, ordered revisions, HTTP logout retaining the second connection, revoked-recipient exclusion, immediate HTTP suspension and pending-to-approved transition without reconnect. Test fixtures own disposable databases and sessions; development data is retained.
- Final `pnpm typecheck`, `pnpm lint` and `pnpm build` passed. The existing lazy LiveKit bundle-size advisory remains non-failing.
- Final `pnpm --filter @tricord/api test:desktop` passed all three disposable-profile launches and existing 26 authentication/messaging/voice/notification/lifecycle checks, plus new ready presence and narrow drawer focus-entry, Escape, focus-return and overflow assertions. These exercise the unpackaged Windows Electron renderer, not a signed installed release.
- Final `pnpm --filter @tricord/api test:browser` passed the existing 30 auth/messaging/unread/notification checks plus live independent-account Online/Offline propagation, two connections producing one row, one remaining connection preserving Online, final disconnect grace, participant/community switching, retained row focus after an actual roster refetch, intentional outside blur without focus stealing, mobile drawer focus/Escape/return and covered-chat unread protection. Online propagation uses a five-second assertion deadline; final disconnect allows the configured grace plus the five-second propagation target. Edge runs headlessly with isolated fixture users/profile.
- Task-file Prettier checks and `git diff --check` passed. Whole-tree `pnpm format:check` flags only five pre-existing `.github/agents/*.agent.md` files; they were left intact.

Review corrected the snapshot deadline, focus retention across roster refresh/regrouping, intentional outside-focus handling, immediate private cache removal on known conversation access loss, and stale failed roster responses. The first browser run used an intermediate build missing a realtime message listener; the listener was restored and the rebuilt browser suite passed. Local containers had stopped before the final UI rerun; `pnpm db:up` and `pnpm voice:up` restarted the existing services without removing volumes or changing credentials.

Remaining manual acceptance: real screen-reader interaction, physical browser/Electron devices, actual WAN/crash heartbeat timing, sustained network interruption and real API-process restart recovery. Controlled service-state tests cover uncertainty/recovery semantics, but are not evidence of those environments. The ten-account integration test bounds presence deltas and snapshot requests; it is not a packet capture or a long-duration rapid-reconnect stress certification. Publication and deployment remain separate authorized stages.

The maintainer reported that all requested local manual checks worked, including the two-account/member views, drawer keyboard interaction, Narrator, disconnect and API restart checklist. This is user-reported local acceptance; it is not independently observed screen-reader, physical-device or WAN/crash timing evidence.

PR preparation integrated only the presence changes onto develop `264fcc7`, preserving newer hyperlink behavior/tests and dependency changes. On that combined source, full formatting, lint, typecheck, builds, 175 unit/regression tests, 89 database tests and the headless browser smoke (31 existing checks plus presence regressions) passed. Electron passed all three launches and 27 existing checks plus presence/drawer assertions. The isolated checkout initially failed the pre-existing notification shortcut target check because its Electron executable path differed; rerunning the built PR source with the original identical Electron 45.0.0 executable passed, and the development shortcut bytes were restored afterward. Temporary diagnostic source changes were restored and are excluded from the commit. The original dirty checkout was retained separately; no unrelated local work is included.
