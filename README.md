# Rajcord

Active public repository: [Treca-Raja/rajcord-public](https://github.com/Treca-Raja/rajcord-public).

## Naming and compatibility

The project and repository are now Rajcord. Open [rajcord.code-workspace](rajcord.code-workspace) from the current checkout; local folder names are independent of GitHub repository names. AI skill names use the `rajcord-` prefix.

Existing technical identifiers remain compatible: `@tricord/*` workspace packages, `TRICORD_*` environment variables, `tricord_session`, database users/names, Docker projects/volumes, local image tags, server paths and systemd units. Keep using their documented names so existing configuration and data remain accessible. The Windows client/installer uses Rajcord identity and a separate per-user profile; see [desktop distribution](docs/desktop-distribution.md). Historical verification and milestone documents retain the names used at the time.

See the [naming inventory](docs/naming.md) for audited surfaces, retained identifiers and overlap with the desktop distribution work.

Release images now target `ghcr.io/treca-raja/rajcord-public`. Verify package access and host pull credentials before releasing; a repository rename does not migrate a registry package or existing deployed data.

## Application overview

Milestone 2C adds local community voice channels to the authenticated React/Electron application, alongside persistent shared text channels, private DMs and group DMs. Browser and desktop use the same messaging UI. PostgreSQL is the source of truth; authentication and account approvals from Milestone 2A are preserved.

## Working with coding agents

Start with [AGENTS.md](AGENTS.md) for project rules, [MEMORY.md](MEMORY.md) for dated context and [SKILLS.md](SKILLS.md) for reusable planning, documentation, verification, database, voice and hosting workflows. Repository skills can be used with Copilot/VS Code or Codex; check discovery in the selected tool.

Changes follow `feature/* -> develop -> main`: create feature branches from `develop`, target `develop` with feature PRs, and release through a `develop`-to-`main` PR. See [CONTRIBUTING.md](CONTRIBUTING.md). The deployment-option skill describes future component switches; those switches are not implemented yet.

## Windows prerequisites

Windows 11, Node.js 24 LTS, pnpm 11.25.0, Git and Docker Desktop running Linux containers. Keep PostgreSQL and the API on loopback.

Run commands from your current clone (for example `C:\path\to\rajcord-public`). If PowerShell cannot find the already-installed tools, add their locations for the current terminal:

```powershell
$env:Path += ";$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback"
$env:Path += ";$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
Set-Location C:\path\to\rajcord-public
```

On another machine, install pnpm normally with `npm install --global pnpm@11.25.0` and reopen PowerShell after installing Docker Desktop.

## Setup and first owner

```powershell
Set-Location C:\path\to\rajcord-public
pnpm install --frozen-lockfile
pnpm setup:desktop
pnpm db:setup
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm owner:bootstrap
```

The last command runs a **local interactive CLI**. Enter a new, unused username, a display name, and a password of 12–128 characters. The password is hidden and is never passed as a command-line argument or printed. Do not put a password in a shell command or committed file. Bootstrap creates one approved owner atomically. Repeating it stops without changing anything. An existing public registration is never automatically promoted; choose an unused owner username. No owner was created in your development database by the automated tests.

`db:setup` creates matching random database credentials in ignored `infrastructure/.env` and `apps/api/.env` only when both are absent. It preserves existing files. Never regenerate the password for an initialized volume. For an older checkout, ensure `apps/api/.env` contains this origin list while preserving its existing DATABASE_URL:

```dotenv
HOST=127.0.0.1
PORT=3001
WEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001
```

The browser uses same-origin requests. Vite proxies `/api` and `/socket.io` to Fastify. No browser credentials or API URL belong in a Vite environment file.

## Daily startup

```powershell
Set-Location C:\path\to\rajcord-public
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm dev
```

Open **http://127.0.0.1:5173**. Sign in as the owner. Friends can create accounts and sign in to see their pending status. Open **Settings → People & approvals** to approve or reject registrations. Every approved member has those approval controls. Owner-only suspend, restore, remove and ownership-transfer controls appear for eligible accounts. Approvals reach connected users automatically.

To run the desktop app, stop `pnpm dev` with Ctrl+C, then:

```powershell
pnpm dev:desktop
```

The API uses Node’s watch mode with the existing tsx TypeScript loader. Desktop startup waits up to 30 seconds for Vite and a valid Rajcord API health response, then opens Electron. If startup fails, it names the unavailable service and stops the helpers instead of waiting forever.

The same screens run in the sandboxed Electron renderer. A normal development desktop exit stops its helpers and returns success; actual app/helper failures still fail. Minimize retains the session. Closing a development window quits. Installed Rajcord closes to the tray; **Quit Rajcord** or Ctrl+Q exits and disconnects voice. Temporary sessions are revoked on an orderly online quit and their local cookie is removed. Remembered sessions survive restart for up to 30 days. Settings includes display-name changes, password changes, device revocation and logout.

## Rajcord Windows installer

```powershell
pnpm desktop:package
pnpm desktop:audit
```

The Windows x64 NSIS installer is written to `artifacts/desktop/Rajcord-Setup-0.1.0-x64.exe` (version from `apps/desktop/package.json`). Installed clients always connect to `https://rajcord.com`. The default unsigned build supports manual installation; verified automatic updates require a signed build. See the [desktop distribution runbook](docs/desktop-distribution.md) for signing, versioning, guarded GitHub draft releases, install testing and manual voice/update acceptance gates. No release is published by a local build.

Feature PRs target `develop`; reviewed integration then moves through a separate `develop` → `main` PR. Windows review builds run for both branches, while release publication stays restricted to explicitly authorized dispatches on `main`. Text files use LF on every platform through `.gitattributes`.

From another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/ready
docker compose --env-file infrastructure/.env -f infrastructure/compose.yaml ps
```

Readiness checks a real database connection; it does not apply migrations. PostgreSQL is bound only to **127.0.0.1:5432**, using the existing named volume `infrastructure_tricord_postgres`.

## Shutdown

Close Electron if it is running, then press **Ctrl+C** in the development terminal. Stop PostgreSQL with:

```powershell
Set-Location C:\path\to\rajcord-public
pnpm voice:down
pnpm db:down
```

This preserves the database volume. Never use `down -v`, volume removal or pruning for this project.

## Messaging behavior

Explicit `http://` and `https://` URLs become clickable links, as do simple Markdown links such as `[GitHub](https://github.com)`. Links open in a new browser tab (the default browser from Electron); hover shows the normalized destination, including the ASCII form of international domain names. Common trailing sentence punctuation and paired emphasis markers are excluded from automatic URL targets. Only HTTP(S) destinations without embedded credentials are accepted; HTML stays escaped. Link destinations support balanced parentheses; incomplete destinations, spaces and Markdown link titles remain literal. Backtick code spans and fenced blocks remain literal, and other Markdown formatting is not interpreted. This applies to stored, incoming and edited messages without changing their stored text.

After `pnpm build` and `pnpm setup:desktop`, run `pnpm --filter @tricord/desktop test:links` for an isolated Electron link smoke that needs no database or LiveKit. It exercises real window-open events with a recording OS adapter; it does not launch an external browser. The test profile is separate from the normal desktop profile.

For authenticated desktop chat verification after building, run `pnpm --filter @tricord/api test:desktop --chat-only`. It checks links in sent, received and restored messages across three launches, along with authentication and session regressions, without microphone access or voice tests. PostgreSQL and the harness's LiveKit prerequisite must be configured and running. Omitting `--chat-only` retains the existing combined desktop/voice suite.

Approved members can create, rename, archive and reopen shared channels. Use the sidebar plus buttons to open a DM or create a group; clicking a community member opens the same persistent DM for that pair. Groups start with the creator as manager. Any current member can invite approved users, but invitees must accept in their inbox. Only the manager can remove members, rename the group or transfer management. A manager must transfer before leaving a nonempty group.

Public channel forms support readable names (1–80 Unicode code points, including spaces/emoji), an optional topic (up to 500 code points), a category and shared numeric ordering (0–2147483647; lower first). Names are NFC-normalized, surrounding/repeated whitespace is collapsed and lowercase-normalized names must be unique, including archived channels. Control/bidirectional-override characters are rejected; topics are single-line plain text. Existing channel IDs, message history and read progress do not change when details change.

Use **Categories · Create & manage** beneath **TEXT CHANNELS** to create, rename, order or remove public categories. The sidebar button provides quick hover/press feedback. Channel create/settings forms also link to category management; their **Category** selector assigns the channel. Category names support 1–48 Unicode code points with the same normalization/uniqueness rules. Removing a category requires confirmation and moves its channels, including archived channels, to **Uncategorized** without deleting history. Categories and channels use stable tie-breaks when order numbers match. Category lists are paginated; **Load more categories** reveals additional choices. All approved members retain public-channel/category management rights; this adds no private channels or new group/DM naming permissions.

Channel/category forms retain their original revision while being edited. Changes from another window are announced; **Reload channel details** / **Reload category details** explicitly discards unsaved form edits and loads the current values before saving. The server rejects stale edits/reorders rather than overwriting newer details. Archived channels must be restored before their name/topic/category/order can be changed; author-only message edits/deletes remain available. Dialogs support Escape, contained keyboard focus and focus restoration to their opener.

New group members see messages sent after acceptance. Leaving or removal immediately denies group access. Rejoining restores messages from earlier membership periods plus new messages, while messages sent during the absence remain hidden. These rules apply to history pages, direct message IDs and realtime synchronization.

Messages are plain text, limited to 4,000 characters. Enter sends; Shift+Enter adds a newline. Only the author can edit/delete, including in archived channels; administrators have no override. Deletion clears content and retains a stable tombstone for synchronization. History otherwise has no automatic expiry. “Load older messages” uses server sequence pagination.

The composer keeps unsent text and reply targets when switching conversations within the running client, including pending/unconfirmed send IDs. Retrying an unconfirmed send reuses the same intended body/target identifier; changing the target creates a new attempt. A send completing after a switch updates the reopened composer rather than leaving a duplicate draft. Drafts are memory-only and clear on logout/reload or loss of conversation access. There is no durable offline queue or persistent draft storage.

Hover a message for **Reply**; right-click it for the complete action menu, including **Open thread**, **Add reaction**, pin/unpin and permitted edit/delete actions. The three-dot button also opens the menu, including on touch; focused messages support Shift+F10/the context-menu key, arrow keys and Escape. Actions do not occupy permanent rows. Timestamps and edit/pin metadata sit on the right. **Cancel reply** clears the current target. **Open thread** shows its root and single-level replies. Replying to a reply retains both the immediate target and the same root. These remain ordinary canonical messages in the parent timeline, not copies or separate unread entries. Opening/reading a thread never advances the parent read cursor. Inaccessible/deleted ancestors show safe placeholders; jumps and thread items follow current membership and membership-period visibility. **Jump to unread** selects the first accessible unread message; **Jump to latest messages** leaves older-history mode. Reading history does not force-scroll on new arrivals.

**Pinned messages** toggles a paginated drawer with jumps to originals beyond loaded history; click it again to close. The drawer slides over history without snapping the timeline width, leaves the composer accessible and shows its loading shell before waiting for the server. All approved public-channel members, the group manager, or either approved DM participant can pin/unpin; pinning does not grant message edit/delete rights. Deleted or inaccessible messages are absent from both items and counts.

Use **Add reaction** or the composer smile button for categorized Unicode 17 emoji. Search all 3,953 named entries, choose a category or skin tone, then scroll; there are no numbered pages and ordinary browsing shows base families instead of every skin variation. The grid renders only its visible window. Chat/picker/reaction artwork is self-hosted Twemoji SVG, including a pinned Unicode-17 supplement, so joined sequences and flags do not depend on the OS emoji font. The text font is self-hosted Inter. Settings includes the font/artwork attribution and licenses; neither loads a font or emoji provider. The optional name/search catalog still loads only when needed.

Reactions persist, count each user's choice once and let users remove only their own choices. Their pills hang below, outside the message highlight; adding them does not expand that field. Up to 32 different reaction kinds fit on one message, preserving the previous payload bound; existing choices/retries remain available at that limit. Reactions create neither alerts nor unread increments. Archived channels reject replies, pins and reaction mutations; existing author-only message edits/deletes remain available.

Author names, usernames, **You**, timestamps and stable account-derived avatar accents distinguish participants without depending on color or implying a role/presence. Every message has a small avatar on the left and a compact sender header directly above the text, sharing one consistent text edge; there is no separate sender/table column. Timestamps sit at the right of that header. Consecutive rows do not shift indentation. Long identities truncate with a full-name tooltip; reactions align beneath the text outside its highlight. The timeline includes date separators. Hover/menu feedback uses roughly 120 ms transitions; drawers/settings use 160 ms, with motion removed for reduced-motion preferences. History/thread/pin pages default to 50, maximum 100 items; the client bounds loaded windows at 500 messages and incremental catch-up at four pages before explicitly requesting a reload. Unread cursors remain independent of these caches. No uploads, conversation search or blocking per-message prompts are included. Community voice is described below.

Quoted replies have a compact translucent frame. Clicking one opens its authorized original in the main timeline and keeps that message highlighted until another jump or returning to latest messages. Choosing Reply also frames the selected target while composing.

Use the **palette button** in the left rail or **Settings → Appearance** to switch between **Original** (charcoal/green) and **Retro** (racing-green navigation, a soft stone/blue-gray conversation canvas and dark readable text). Retro adds a fine matte-paper grain using a small, static, locally embedded SVG background tile; it does not overlay text, animate noise or contact an asset provider. Original is the default when no preference exists. The choice is saved on this device and synchronized across its same-origin tabs; switching changes styles without reloading chat, changing drafts or touching account data. Storage failures show a warning while leaving the selected theme usable. Both themes keep clear Inter message typography, shared surfaces and quick interactions, not pixel fonts or animated wallpaper. Normal message rows stay unboxed; actions appear on hover/focus for mouse/keyboard users, with a persistent menu control on touch. Short windows keep scrolling inside history rather than pushing the composer below the viewport. Motion stays at 120–160 ms using opacity/small transforms, and reduced-motion preferences remove it; modal backdrops do not blur the entire app.

Theme changes use a 120–160 ms compositor crossfade in browsers with native View Transitions, or a short cancelable opacity fade otherwise. The selected preference updates immediately; rapid changes cancel obsolete animations and cannot reapply an old theme. Transition overlays do not intercept clicks or typing. Reduced-motion preferences and hidden documents apply themes without animation. Both appearances use the same compact message geometry and readable 15 px Inter text with 24 px line spacing, so switching does not rearrange history.

### GIF links and privacy

Use the **GIF** button or `/gif` to search **GIPHY** or **KLIPY** in separate tabs. Press Search to consent to sending the query and loading still previews; later typing in that open picker is debounced. Selecting a result immediately sends its original media URL as one ordinary message, preserving any unsent text. Clicking the GIF button again, focusing the composer, clicking outside, or Escape closes the picker with the same quick transition. The retired Tenor option is no longer offered in the client. Its legacy server contract remains for compatibility, but [Google discontinued the API on June 30, 2026](https://support.google.com/tenor/answer/10455265#whatll-happen-to-the-tenor-api); it is not a viable new setup.

For GIPHY search, create an account at the [GIPHY Developer Dashboard](https://developers.giphy.com/dashboard/), choose **Create an API Key → API**, and copy the key into `apps/api/.env` as `GIPHY_API_KEY=your_key`. See [the example configuration](apps/api/.env.example). Edit the existing ignored file without replacing its database/voice settings, then restart the API/dev task and reopen the picker. GIPHY documents a beta limit of 100 calls per hour; production upgrades require a separate application and may involve pricing. Missing configuration is shown explicitly. Never paste keys into chat or commit them. No account, paid plan or purchase is created automatically. **GIPHY requires direct-browser searches**: its public key is intentionally visible to approved clients, and it receives client IP/search terms. Its returned media URLs/query parameters are preserved. The legacy Tenor key remains server-side. Queries/results/timeouts are bounded; provider attribution remains visible.

For KLIPY, use the [Partner Panel](https://partner.klipy.com/) → API Keys to create a platform/key, then add `KLIPY_API_KEY=your_key` to the same existing ignored `apps/api/.env` and restart the API/dev task. Testing keys are documented as limited to 100 requests per hour; production access requires a separate application. Like GIPHY, KLIPY requires direct browser requests, so its public key is intentionally returned only to approved clients. Each tab requires Search consent before contacting that provider; switching clears old results and does not search the newly selected provider automatically. The picker uses the required **Search KLIPY** placeholder, provider-order results, unchanged delivery URLs and a visible attribution link. KLIPY content filtering is managed through its Partner Panel; the app does not promise an uncensored or identical Tenor catalog. No account, purchase, proxy or media cache is created automatically.

Direct HTTPS `.gif` links from `media.giphy.com`, `media0.giphy.com`–`media4.giphy.com`, `i.giphy.com`, `media.tenor.com` and `static.klipy.com`/`static1.klipy.com`/`static2.klipy.com` offer opt-in message previews. Other HTTPS links remain usable as text. **Load GIF (paused)** is consent to contact the CDN: it learns the connection's IP address, but the client omits credentials/referrer and rejects redirects. Search uses only the fixed provider API endpoints; there is no arbitrary server URL fetch, media proxy, upload, iframe or HTML embedding.

Supported secure-context Chromium browsers use native `ImageDecoder`/canvas for explicit **Play GIF**, **Pause GIF** and **Stop / unload GIF** controls. Loading starts paused, respects reduced motion and pauses when hidden/offscreen. Unsupported decoding, CORS denial and media failures report an explanation without removing text/link access. Limits are 5 MiB downloaded, 2048×2048 pixels, 300 frames, 16,777,216 cumulative decoded pixels, a 15-second initial-load deadline and two loaded previews per client; at most two eligible links per message offer controls. Decoded frames are not accumulated. Stop, unmount and access revocation release resources.

## Unread messages, mentions and notifications

Unread counts and @mention badges appear beside channels, DMs and groups, and the window title shows the total unread count. Read progress is saved per account in PostgreSQL and shared across devices. Authenticated sockets carry unread summaries and read acknowledgements without extra HTTP inbox polling; read acknowledgements are coalesced while reading continuously, and existing request limits remain unchanged. Your own messages and deleted messages do not count as unread. Group counts follow the same membership-history rules as message access. Existing history starts unread until you open it.

Opening a conversation at its latest messages marks earlier accessible messages read only while the window is focused and visible, with no dialog or mobile navigation covering it. Scrolling up preserves unread status for new arrivals and does not jump you away from history; use **Jump to latest messages** to catch up. Simply fetching history never marks it read. These are private account read cursors, not read receipts shown to other members.

Write **@username** to mention someone. Typing `@` offers approved visible members, including **You**; prefix typing filters the list, and Enter/Tab or touch selects a canonical username rather than a mutable display name. Self mentions can be inserted/highlighted but do not produce self-alerts or unread mention counts. Exact ASCII usernames match case-insensitively with Unicode-aware token boundaries; email-like text and partial/similar names do not mention another account. The server resolves recipients by account ID, excludes self/inaccessible recipients and supplies highlights/counts. Repeating a mention counts once; edits/deletions update counts without fresh alerts. There are no @everyone/@here broadcasts.

Typing `@` also suggests accessible text and voice channels. Selected channel names stay readable in the draft and encode stable IDs when sent, so renames cannot retarget them. A channel link only navigates: text links open that channel, and voice links reveal its existing controls without joining, capturing a microphone or alerting everyone. Unknown/inaccessible references show a neutral unavailable label.

Open the **Settings** cog at the bottom-right of your sidebar profile, then **Notifications**. First-time users receive a nonblocking **Set up notifications** invitation; dismissing it is remembered per account/device. Opening setup alone does not request OS permission or enable audio. Account-private conversation settings are **All messages**, **Mentions and replies**, or **Muted**; defaults remain All for DMs/groups and Mentions and replies for public channels. Replies alert the immediate target's author, not automatically the root author. Sender mute/priority settings also sync per account. Priority only decorates eligible alerts: it never overrides global disable, conversation mute, sender mute or OS denial. A mention-plus-reply produces one alert; mutes never hide messages or erase unread badges.

**Enable notifications** in Settings enables availability on this browser/device; popup and sound delivery are independent opt-ins and may both be off. Enabling popups requests browser/OS permission through that user action, with an explicit retry control if blocked. Popups use a nonblocking in-app toast while focused or an opt-in browser/OS popup while away, never both for one delivery. **Notification sound**, **Enable / test sound** and **Volume** provide explicit opt-in, preview and recovery after autoplay restrictions. Denial/failure is reported, not silently replaced with unexpected audio. OS previews stay generic, without message text, names or media; clicking reauthorizes the target message/thread. In-app reason previews are separately configurable.

Device settings and bounded short-lived same-account tab-coordination records use localStorage; authentication remains in HttpOnly cookies, and drafts never use persistent storage. Cooperating same-origin tabs coordinate one delivery and focused-conversation suppression. Distinct browsers/devices may alert independently. **Disable notifications** disables both deliveries without affecting unread badges.

On Windows, enabling alerts registers a **Rajcord development** Start Menu shortcut for Electron notifications. The app reports setup or native delivery failure instead of silently claiming success. Windows notification settings and Do Not Disturb can still suppress visible banners. The development shortcut is for notification registration; start development services with the commands above.

Notifications require Rajcord to stay open (minimized is fine). There is no push delivery after closing the browser/app and no replay of old alerts on edits, reload or reconnect; persisted unread counts catch up instead. Public browser hosting requires trusted HTTPS.

## Verification

With Docker Desktop running (the database suite and browser/Electron smoke also require the local voice service):

```powershell
Set-Location C:\path\to\rajcord-public
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm db:migrate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
pnpm --filter @tricord/api test:browser
pnpm --filter @tricord/api test:desktop
pnpm --filter @tricord/api test:voice
pnpm --filter @tricord/api test:voice:load
pnpm db:verify-persistence
pnpm db:migrate
pnpm peers check
pnpm audit --prod
```

There are **139 passing Vitest tests**: 51 unit/regression tests and 88 database integration tests, including unread persistence, mention boundaries, membership privacy, read-cursor validation and notification delivery authorization. The browser and Electron commands are additional integration scenarios, separate from that count.

- `test:db` checks the existing development schema with unique disposable rows. Authentication and messaging tests create uniquely named temporary databases, migrate it, then drop **only the database created by that test run**. Your development database, owner, migration history and volume are preserved. The local development database role must have CREATEDB permission for these tests.
- The browser smoke runs real headless Microsoft Edge with an isolated temporary profile and disposable database. It checks registration, pending restrictions, approval, cookies, administrator UI, reload persistence and live suspension. It also verifies channel messaging across independent sessions, plaintext rendering, editing/deletion, DMs, group invitation acceptance and history privacy: 11 authentication plus 19 messaging/unread/notification checks (30 total); OS notifications are mocked for deterministic permission, preview and click tests. It captures desktop/mobile screenshots. Edge's default Windows path is used; set `TRICORD_BROWSER_PATH` to another installed Chromium executable if needed.
- The Electron smoke uses three real launches with an isolated temporary profile. It verifies registration, live approval, account settings, logout, minimization, temporary-session cleanup and remembered-session restoration, plus renderer isolation and absence of localStorage tokens. Sending, receiving from an independent account and restored message history plus voice device selection, microphone publication, camera denial, mute/deafen and leave bring the total to 26 checks, including notification IPC validation, Windows registration and a real native notification show event.
- Browser/Electron smoke servers bind to **127.0.0.1:3003 / :3002**, respectively. Reports/screenshots go to ignored `artifacts/`. Their temporary profiles are separate from your real browser and desktop profile.
- `db:verify-persistence` restarts the existing PostgreSQL container, uses its own disposable database to verify accounts, sessions, audit records, invitations, channels, DMs, group history boundaries, idempotent retries and message persistence. Existing Fastify/pg pools must recover. It then drops only its own test database and verifies the development migration journal is unchanged. Run it when interrupting development connections is acceptable.
- `pnpm test:browser` and `pnpm test:desktop` are convenience commands that build first. Tests fail when required infrastructure is missing; they do not silently skip.

## Run the built applications locally

```powershell
pnpm build
# Terminal A
pnpm --filter @tricord/api start
# Terminal B
pnpm --filter @tricord/desktop start
```

The backend serves built web assets at **http://127.0.0.1:3001**. You can also open that address in a browser. Built Electron loads this same origin instead of file URLs. The API must be running.

These commands test production **build artifacts on local HTTP**. They do not deploy production infrastructure. Future HTTPS deployment must use `NODE_ENV=production` and an explicit HTTPS-only `WEB_ORIGINS` list; this enables Secure cookies and rejects HTTP origin configuration. Reverse proxy, TLS and distributed rate limits are not deployed. An exact HTTPS desktop-server URL can now be configured; see the hosting preparation guide.

## Database migrations

The original `0000_mute_darkstar.sql` and `0001_boring_guardian.sql` are unchanged by Milestone 2B. The additive `0001_boring_guardian.sql` extends approval status and adds credentials, sessions, a singleton owner designation, approval history and case-insensitive username uniqueness.

```powershell
pnpm db:generate
# Review new SQL and metadata. Never rewrite an applied migration.
pnpm db:migrate
```

Additive `0002_overrated_puck.sql` creates conversations, membership periods, invitations and messages, including ordering, idempotency and DM-pair constraints. It seeds the shared `general` channel. Milestone 2C migration 0003 adds persistent voice_channels and seeds The lounge; there are now ten public tables. Existing users remain intact. Rows from the foundation without credentials cannot sign in. Existing usernames that differ only by case would block the new unique index safely; reconcile such a conflict deliberately rather than deleting accounts or resetting migrations.

## Security and current limits

Passwords use Argon2id. Random session tokens are stored only as hashes in PostgreSQL and HttpOnly SameSite=Strict cookies on clients. CSRF tokens stay in renderer memory. Mutations require an exact trusted Origin; authenticated mutations also require session-bound CSRF. Sessions have absolute 12-hour or 30-day expiry. Logout, password changes, device revocation, suspension and removal invalidate server sessions. Status and owner permissions are checked in the backend, including each protected socket event.

Removed accounts become tombstones, preserving audit and identity history. They cannot sign in. Administration grants no application access to private conversations and no permission to edit/delete another author’s messages. Messages are not end-to-end encrypted: the database operator can read stored content. Security configuration remains local operator configuration; there is no public settings editor or endpoint granting members control over it.

Crash/offline quits cannot guarantee immediate server revocation. Electron discards temporary local cookies at startup, and remaining server sessions expire within 12 hours or can be revoked from another device. Browser session restoration may preserve session cookies according to browser settings. No password recovery, MFA, email verification, TLS deployment, signed installer or multi-process socket adapter is implemented. HTTP/socket event limits are in-process; the message-send quota is persisted in PostgreSQL. This implementation targets a single API process and up to ten friends. Login errors are generic; registration necessarily reveals whether a username can be used.

See [security decisions](docs/decisions.md) and [verification evidence](docs/verification.md). Recommended next: validate real headsets and hardware disconnection behavior, then add private/group calling and blocking rules. Leave video/streaming and cloud deployment for later.

## Local voice channels (Milestone 2C)

LiveKit 1.13.10 runs as a separate local Docker service. Approved users can create persistent voice channels and join one channel per account across devices. Each room is capped at ten participants. Private calls, push-to-talk, streaming, tray behavior and hosting are later milestones.

First-time voice setup (preserves all existing database files and data):

```powershell
Set-Location C:\path\to\rajcord-public
pnpm voice:setup
pnpm voice:up
pnpm db:up
pnpm db:migrate
pnpm dev:desktop
```

The setup command creates random keys in ignored infrastructure/.env.voice and preserves an existing file. The API reads this file locally. LiveKit control/signaling (7880), media TCP (7881) and media UDP (7882) are bound only to 127.0.0.1. No public STUN/TURN service, paid service or cloud deployment is used. Docker Compose keeps the voice service separate from the PostgreSQL volume.

In the sidebar, open **Audio controls → Find audio devices**, allow microphone permission, select a concrete microphone and speakers, then choose a channel. Joining starts muted. Use the microphone, deafen and leave buttons; participant sliders control playback volume independently. Deafen also suppresses your microphone and restores your prior mute preference when disabled. “Enable audio playback” handles browser autoplay restrictions.

Device discovery briefly opens and immediately stops a microphone to reveal device labels. It does not transmit audio. Calls use exact device IDs, excluding the Windows Default/Communications aliases. A missing microphone stops transmission; missing speakers mute playback. Choose a replacement explicitly. Browser/OS device-disconnection notifications determine when this is detected. This milestone requires output-selection support, verified in Edge and Electron on Windows 11; other browsers are not yet certified.

Network reconnection preserves in-memory mute/deafen, devices and participant volumes. Voice reservations have a 45-second heartbeat lifetime; still-authenticated clients can obtain a fresh reservation after expiry or an API restart. Manual leave, logout, suspension and full quit stop client recovery. Fresh launches never join automatically. An offline quit can leave a server reservation for up to 45 seconds.

Voice uses the existing session cookie and CSRF boundary. The API issues an opaque reservation credential, not a LiveKit bearer token. Its same-origin signaling gateway reauthorizes each handshake and replaces refreshed LiveKit tokens before forwarding them. Only microphone publication is granted. Removal is enforced at the media server; a one-second sweep also handles expiration and external account changes. This is a single-API-process development design. LiveKit terminates media encryption; it is not end-to-end encryption.

Run the real two-browser synthetic-audio test after building:

```powershell
pnpm build
pnpm --filter @tricord/api test:voice
```

This test covers actual received audio, independent sessions, mute/deafen, selected output, volume, disconnect/reconnect, API restart, simulated device loss and revocation. Electron tests also publish a synthetic microphone track and deny camera capture. Physical microphones, unplugging real USB/Bluetooth hardware, listening quality and WAN/TURN behavior still need manual validation.

## Ten-client voice reliability test

Start Docker Desktop and the existing services first:

```powershell
Set-Location C:\path\to\rajcord-public
docker desktop start
pnpm db:up
pnpm voice:setup
pnpm voice:up
pnpm test:voice:load
```

This command checks PostgreSQL and authenticated LiveKit readiness before building, then launches ten isolated headless Edge processes with synthetic microphones. If a service is stopped, it exits with startup instructions before spending time on the build. The direct API test command also checks readiness. It runs a 65-second steady audio test, rejects an eleventh account, drops all signaling connections, restarts only its disposable Fastify instance, verifies recovery, frees and reuses a slot, then checks that leaving closes peer connections and microphone tracks. Each connected client must receive nine audio streams and retain exactly two active peer connections (publisher/subscriber). Audio byte counts must advance at every sample. Production HTTP rate limits stay enabled, with no HTTP 429 responses allowed.

The test binds to **127.0.0.1:3005** and uses a temporary database and unique LiveKit room prefix. It cleans up its own browser profiles and resources; development accounts, database volumes, the main API and other voice rooms are preserved. Allow several minutes and enough memory for ten browser processes. It never opens physical microphones. The ignored report **artifacts/voice-load.json** includes checks, per-client WebRTC counters, API health latency, event-loop delay and API/test-process memory. That memory measurement excludes Docker and browser processes.

Static files no longer consume the API rate budget. Each voice endpoint has its own 120-request/minute/IP budget, so ten clients sharing one address can heartbeat and poll without blocking each other. Authentication limits, approval checks, CSRF, origin checks and room capacity remain enforced.

This is ten real software clients on one Windows host using loopback networking, not ten people on different networks. Physical headset quality, Bluetooth/USB changes, long calls and remote networking remain unverified. See [verification evidence](docs/verification.md) for measured results.

## GitHub and hosted alpha preparation

See [hosting preparation](docs/hosting.md) for the tested server image, automated GitHub checks, HTTPS desktop configuration and remaining deployment steps. Local development commands remain unchanged.

The [production deployment runbook](docs/deployment.md) describes the prepared CI/CD pipeline, production approval, certificate renewal and encrypted off-server backup/restore jobs. CI uses disposable test environments; a permanent staging server is not required. Delivery stays disabled until the production host and GitHub environment are configured and `HOSTING_ENABLED=true` is set. Verify the hosted stack locally with `pnpm test:hosting` after `pnpm server:build`. Generate server-only configuration with `pnpm hosting:init production PUBLIC_IPV4 ABSOLUTE_DIRECTORY rajcord.com turn.rajcord.com`; omitting the last two arguments retains IP-only TLS. Domain DNS, public certificate issuance and renewal rehearsal have been verified; deployed service reloads and WAN voice still need live validation.

For the Linux VPS, the reviewed host helpers under `scripts/hosting/` prepare Docker/firewall rules, key-only SSH and a separate CI deployment account. `initialize-runtime.sh` generates server-only configuration using the pinned Node container, so host Node installation is optional. The existing VPS now has these foundations and issued public certificates; the encrypted R2 repository is initialized and its storage round trip is verified. The application, live database backup/recovery and active release maintenance jobs remain pending. See the dated verification record before treating a prepared component as live.

For first-release image preparation, `gh workflow run verify.yml --ref main -f publish_only=true` tests and publishes the current-main image without entering production policy/approval/deployment jobs. Keep `HOSTING_ENABLED=false` while configuring GHCR image access. The normal workflow's publication and approval-gated deployment behavior is unchanged when this manual input is false.

Andrej se igra
